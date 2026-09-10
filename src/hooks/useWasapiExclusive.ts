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
// Routes local-file playback through the WASAPI exclusive-mode (bit-perfect) engine when the
// setting is on. The HTML5 element keeps running as the transport/metronome (progress, lyrics,
// ended→next), but the renderer's audio is muted via `webContents.setAudioMuted` so the WASAPI
// output is the only thing the listener hears. Seek / pause / resume are mirrored to the engine.
//
// When the device cannot honour the source format (sample rate, bit depth, or an occupied
// endpoint) the engine reports `fallback` and the renderer is unmuted again, so playback
// continues through Chromium's shared-mode output instead of going silent.

const resolveLocalFilePath = async (song: SongResult): Promise<string | null> => {
    const songId = (song as SongResult & { localRef?: { songId?: string } }).localRef?.songId;
    if (!songId) return null;
    const songs = await getLocalSongs();
    const record = songs.find(candidate => candidate.id === songId);
    return record?.filePath ?? null;
};

export const useWasapiExclusive = (audioRef: RefObject<HTMLAudioElement | null>) => {
    const enableWasapiExclusive = useAudioSettingsStore(state => state.enableWasapiExclusive);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const playerState = usePlaybackStore(selectDisplayPlayerState);

    const activePathRef = useRef<string | null>(null);
    const failedPathsRef = useRef<Set<string>>(new Set());
    const lastMessageRef = useRef<string | null>(null);

    // While the setting is on, the renderer must stay muted: WASAPI owns the audible output.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi) return;
        if (enableWasapiExclusive) {
            failedPathsRef.current = new Set();
            void wasapi.setRendererMuted(true);
        } else {
            void wasapi.stop();
            void wasapi.setRendererMuted(false);
            activePathRef.current = null;
        }
        return () => {
            void wasapi.stop();
            void wasapi.setRendererMuted(false);
        };
    }, [enableWasapiExclusive]);

    // Play / pause / resume routing for the current local song.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi || !enableWasapiExclusive) return;

        const song = currentSong;
        if (!song || !isLocalPlaybackSong(song)) {
            activePathRef.current = null;
            void wasapi.stop();
            return;
        }

        let cancelled = false;
        void (async () => {
            const filePath = await resolveLocalFilePath(song);
            if (cancelled || !filePath) return;
            // Already fell back for this file: stay on shared mode, do not retry.
            if (failedPathsRef.current.has(filePath)) return;

            if (playerState === PlayerState.PLAYING) {
                if (activePathRef.current !== filePath) {
                    activePathRef.current = filePath;
                    void wasapi.setRendererMuted(true);
                    void wasapi.play(filePath, 0);
                } else {
                    void wasapi.resume(filePath, audioRef.current?.currentTime ?? 0);
                }
            } else if (playerState === PlayerState.PAUSED) {
                void wasapi.pause();
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [enableWasapiExclusive, currentSong, playerState, audioRef]);

    // Seek mirroring: the engine restarts at the element's position whenever a seek lands.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        const element = audioRef.current;
        if (!wasapi || !enableWasapiExclusive || !element) return;

        const onSeeked = () => {
            const song = usePlaybackStore.getState().currentSong;
            if (!song || !isLocalPlaybackSong(song)) return;
            const path = activePathRef.current;
            if (!path || failedPathsRef.current.has(path)) return;
            void wasapi.seek(path, element.currentTime);
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
                const path = activePathRef.current;
                if (path) failedPathsRef.current.add(path);
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
