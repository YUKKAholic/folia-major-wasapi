import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState, type SongResult } from '../types';
import { getLocalSongs } from '../services/db';
import { isLocalPlaybackSong } from '../utils/appPlaybackGuards';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import i18n from '../i18n/config';

// src/hooks/useWasapiExclusive.ts
//
// Routes playback through the WASAPI exclusive-mode (bit-perfect) engine when the setting is on.
// Local files are handed over by path; online / Navidrome tracks by their remote URL (the worker
// downloads it to a temp file first).
//
// The HTML5 element stays the transport/metronome (progress, lyrics, ended→next) and its audio is
// left AUDIBLE until the engine actually reports `started`; only then is the renderer muted so the
// WASAPI output is the only thing heard. Every path where the engine is not playing (unsupported
// source, fallback, error, ended, watchdog timeout) unmutes again, so playback never goes silent.

const WATCHDOG_MS = 8000;

const resolveLocalFilePath = async (song: SongResult): Promise<string | null> => {
    const songId = (song as SongResult & { localRef?: { songId?: string } }).localRef?.songId;
    if (!songId) return null;
    const songs = await getLocalSongs();
    const record = songs.find(candidate => candidate.id === songId);
    return record?.filePath ?? null;
};

/** Resolves the engine source and a stable key for the current song, or null when unsupported. */
const resolveWasapiSource = async (
    song: SongResult,
    audioSrc: string | null,
): Promise<{ source: WasapiSource; key: string } | null> => {
    if (isLocalPlaybackSong(song)) {
        const filePath = await resolveLocalFilePath(song);
        return filePath ? { source: { filePath }, key: `file:${filePath}` } : null;
    }
    if (typeof audioSrc === 'string' && /^https?:\/\//i.test(audioSrc)) {
        return { source: { url: audioSrc }, key: `url:${audioSrc}` };
    }
    return null;
};

export const useWasapiExclusive = (audioRef: RefObject<HTMLAudioElement | null>) => {
    const enableWasapiExclusive = useAudioSettingsStore(state => state.enableWasapiExclusive);
    const wasapiDeviceId = useAudioSettingsStore(state => state.wasapiDeviceId);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const playerState = usePlaybackStore(selectDisplayPlayerState);

    const activeSourceRef = useRef<{ source: WasapiSource; key: string } | null>(null);
    const failedSourcesRef = useRef<Set<string>>(new Set());
    const watchdogRef = useRef<number | null>(null);
    const lastMessageRef = useRef<string | null>(null);

    const clearWatchdog = () => {
        if (watchdogRef.current !== null) {
            window.clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
        }
    };

    // If the engine neither starts nor reports a problem in time, stop trying and restore sound.
    const armWatchdog = () => {
        clearWatchdog();
        watchdogRef.current = window.setTimeout(() => {
            watchdogRef.current = null;
            activeSourceRef.current = null;
            void window.electron?.wasapi?.setRendererMuted(false);
            void window.electron?.wasapi?.stop();
        }, WATCHDOG_MS);
    };

    // Toggling the setting: enter cleanly, or release the engine and restore Chromium output.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi) return;
        if (enableWasapiExclusive) {
            failedSourcesRef.current = new Set();
            activeSourceRef.current = null;
        } else {
            clearWatchdog();
            void wasapi.stop();
            void wasapi.setRendererMuted(false);
            activeSourceRef.current = null;
        }
        return () => {
            clearWatchdog();
            void wasapi.stop();
            void wasapi.setRendererMuted(false);
        };
    }, [enableWasapiExclusive]);

    // Keep the engine's exclusive endpoint in sync with the setting.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi || !enableWasapiExclusive) return;
        void wasapi.setDevice(wasapiDeviceId);
    }, [enableWasapiExclusive, wasapiDeviceId]);

    // Play / pause / resume routing for the current song.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi || !enableWasapiExclusive) return;

        const song = currentSong;
        const dropToSharedMode = () => {
            activeSourceRef.current = null;
            // The engine is not going to play this source: hand the output back to Chromium so the
            // (already running) HTML5 element is audible again instead of leaving it muted.
            void wasapi.setRendererMuted(false);
            void wasapi.stop();
        };

        if (!song) {
            dropToSharedMode();
            return;
        }

        let cancelled = false;
        void (async () => {
            const resolved = await resolveWasapiSource(song, audioSrc);
            if (cancelled) return;
            if (!resolved) {
                dropToSharedMode();
                return;
            }
            const key = `${wasapiDeviceId || 'default'}|${resolved.key}`;
            // Already fell back for this source: stay on shared mode, do not retry.
            if (failedSourcesRef.current.has(key)) return;

            if (playerState === PlayerState.PLAYING) {
                if (activeSourceRef.current?.key !== key) {
                    activeSourceRef.current = { source: resolved.source, key };
                    void wasapi.setDevice(wasapiDeviceId);
                    armWatchdog();
                    void wasapi.play(resolved.source, 0);
                } else {
                    armWatchdog();
                    void wasapi.resume(resolved.source, audioRef.current?.currentTime ?? 0);
                }
            } else if (playerState === PlayerState.PAUSED) {
                clearWatchdog();
                void wasapi.pause();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [enableWasapiExclusive, wasapiDeviceId, currentSong, audioSrc, playerState, audioRef]);

    // Seek mirroring: the engine restarts at the element's position whenever a seek lands.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        const element = audioRef.current;
        if (!wasapi || !enableWasapiExclusive || !element) return;

        const onSeeked = () => {
            const active = activeSourceRef.current;
            if (!active || failedSourcesRef.current.has(active.key)) return;
            armWatchdog();
            void wasapi.seek(active.source, element.currentTime);
        };
        element.addEventListener('seeked', onSeeked);
        return () => element.removeEventListener('seeked', onSeeked);
    }, [enableWasapiExclusive, audioRef]);

    // Engine events: mute only while exclusive output is actually live; unmute on every exit path.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi || !enableWasapiExclusive) return;
        return wasapi.onEvent((event) => {
            clearWatchdog();
            if (event.type === 'started') {
                void wasapi.setRendererMuted(true);
                if (!event.bitPerfect && lastMessageRef.current !== 'not-bit-perfect') {
                    lastMessageRef.current = 'not-bit-perfect';
                    setStatusMessage({ type: 'info', text: i18n.t('options.wasapiNotBitPerfect') });
                }
                return;
            }
            if (event.type === 'fallback') {
                const active = activeSourceRef.current;
                if (active) failedSourcesRef.current.add(active.key);
                void wasapi.setRendererMuted(false);
                if (lastMessageRef.current !== event.message) {
                    lastMessageRef.current = event.message;
                    setStatusMessage({ type: 'info', text: i18n.t('options.wasapiExclusiveFallback') });
                }
                return;
            }
            if (event.type === 'ended' || event.type === 'stopped') {
                // Engine no longer owns the output; let the transport be audible again.
                void wasapi.setRendererMuted(false);
                return;
            }
            if (event.type === 'error') {
                // Any engine-level failure means exclusive output is not live; let shared mode sound.
                void wasapi.setRendererMuted(false);
                if (lastMessageRef.current === event.message) return;
                lastMessageRef.current = event.message;
                setStatusMessage({
                    type: 'error',
                    text: i18n.t('options.wasapiExclusiveError') + ': ' + event.message,
                });
            }
        });
    }, [enableWasapiExclusive]);
};
