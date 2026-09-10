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
// downloads it to a temp file first). The HTML5 element keeps running as the transport/metronome
// (progress, lyrics, ended→next), but the renderer's audio is muted via `webContents.setAudioMuted`
// so the WASAPI output is the only thing heard. Seek / pause / resume are mirrored to the engine.
//
// When the device cannot honour the source format (sample rate, bit depth, or an occupied
// endpoint) the engine reports `fallback` and the renderer is unmuted again, so playback continues
// through Chromium's shared-mode output instead of going silent.

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
    const lastMessageRef = useRef<string | null>(null);

    // While the setting is on, the renderer must stay muted: WASAPI owns the audible output.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi) return;
        if (enableWasapiExclusive) {
            failedSourcesRef.current = new Set();
            void wasapi.setRendererMuted(true);
        } else {
            void wasapi.stop();
            void wasapi.setRendererMuted(false);
            activeSourceRef.current = null;
        }
        return () => {
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
        if (!song) {
            activeSourceRef.current = null;
            void wasapi.stop();
            return;
        }

        let cancelled = false;
        void (async () => {
            const resolved = await resolveWasapiSource(song, audioSrc);
            if (cancelled) return;
            if (!resolved) {
                activeSourceRef.current = null;
                void wasapi.stop();
                return;
            }
            // The device is part of the key so switching endpoints restarts on the new one.
            const key = `${wasapiDeviceId || 'default'}|${resolved.key}`;
            // Already fell back for this source: stay on shared mode, do not retry.
            if (failedSourcesRef.current.has(key)) return;

            if (playerState === PlayerState.PLAYING) {
                if (activeSourceRef.current?.key !== key) {
                    activeSourceRef.current = { source: resolved.source, key };
                    void wasapi.setDevice(wasapiDeviceId);
                    void wasapi.setRendererMuted(true);
                    void wasapi.play(resolved.source, 0);
                } else {
                    void wasapi.resume(resolved.source, audioRef.current?.currentTime ?? 0);
                }
            } else if (playerState === PlayerState.PAUSED) {
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
            void wasapi.seek(active.source, element.currentTime);
        };
        element.addEventListener('seeked', onSeeked);
        return () => element.removeEventListener('seeked', onSeeked);
    }, [enableWasapiExclusive, audioRef]);

    // Engine events: keep the renderer muted only while exclusive output is actually live.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi || !enableWasapiExclusive) return;
        return wasapi.onEvent((event) => {
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
            if (event.type === 'error') {
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
