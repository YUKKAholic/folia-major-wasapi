import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState, type SongResult } from '../types';
import { getLocalSongs } from '../services/db';
import { isLocalPlaybackSong } from '../utils/appPlaybackGuards';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { setWasapiMode, type WasapiMode } from '../stores/useWasapiStatusStore';
import i18n from '../i18n/config';

// src/hooks/useWasapiExclusive.ts
//
// Routes playback through the WASAPI exclusive-mode (bit-perfect) engine when the setting is on.
// Local files are handed over by path; online / Navidrome tracks by their remote URL (the worker
// downloads it to a temp file and reuses it across seeks).
//
// The HTML5 element stays the transport/metronome (progress, lyrics, ended→next) and its audio is
// left AUDIBLE until the engine reports `started`; only then is the renderer muted. Every path
// where the engine is not playing (unsupported source, fallback, error, ended, watchdog timeout)
// unmutes again, so playback never goes silent.
//
// Commands are issued only on an actual change (new source, or a play/pause transition), never on
// every render: a source that is already playing is left alone.

const WATCHDOG_MS = 12000;
/** Online playback downloads the whole file first; allow well past the worker's 60s fetch cap. */
const WATCHDOG_URL_MS = 70000;

const resolveLocalFilePath = async (song: SongResult): Promise<string | null> => {
    const songId = (song as SongResult & { localRef?: { songId?: string } }).localRef?.songId;
    if (!songId) return null;
    const songs = await getLocalSongs();
    const record = songs.find(candidate => candidate.id === songId);
    return record?.filePath ?? null;
};

/** True for an absolute Windows path (drive-letter or UNC). Folia stores relative paths for
 * folder-granted libraries, which the main process cannot open directly. */
const isAbsoluteWindowsPath = (value: string): boolean =>
    /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');

/** Reads a renderer-local source (blob URL) into bytes the engine can spill to a temp file. */
const bufferFromAudioSrc = async (
    audioSrc: string | null,
    name: string,
): Promise<{ source: WasapiSource; key: string; isUrl: boolean } | null> => {
    if (typeof audioSrc !== 'string' || !audioSrc) return null;
    try {
        const response = await fetch(audioSrc);
        if (!response.ok) return null;
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength === 0) return null;
        return { source: { kind: 'buffer', name, bytes }, key: `buf:${name}`, isUrl: false };
    } catch {
        return null;
    }
};

/** Resolves the engine source and a stable key for the current song, or null when unsupported. */
const resolveWasapiSource = async (
    song: SongResult,
    audioSrc: string | null,
    allowOnline: boolean,
): Promise<{ source: WasapiSource; key: string; isUrl: boolean } | null> => {
    if (isLocalPlaybackSong(song)) {
        const filePath = await resolveLocalFilePath(song);
        if (filePath && isAbsoluteWindowsPath(filePath)) {
            return { source: { filePath }, key: `file:${filePath}`, isUrl: false };
        }
        // Folia exposes library files through a File System Access handle, so there is no OS path;
        // hand the engine the blob the player is already using instead.
        return bufferFromAudioSrc(audioSrc, `blob:${audioSrc}`);
    }
    if (typeof audioSrc !== 'string' || !audioSrc) return null;
    if (/^https?:\/\//i.test(audioSrc)) {
        if (!allowOnline) return null;
        return { source: { url: audioSrc }, key: `url:${audioSrc}`, isUrl: true };
    }
    // A cached track is served as a blob URL; send its bytes when online exclusive is enabled.
    if (allowOnline && audioSrc.startsWith('blob:')) {
        return bufferFromAudioSrc(audioSrc, `blob:${audioSrc}`);
    }
    return null;
};

/** The reusable form of a source: a buffer's bytes are only sent on the first play. */
const sourceRef = (source: WasapiSource): WasapiSource =>
    'kind' in source && source.kind === 'buffer' ? { kind: 'buffer', name: source.name } : source;

export const useWasapiExclusive = (audioRef: RefObject<HTMLAudioElement | null>) => {
    const enableWasapiExclusive = useAudioSettingsStore(state => state.enableWasapiExclusive);
    const wasapiDeviceId = useAudioSettingsStore(state => state.wasapiDeviceId);
    const enableWasapiExclusiveOnline = useAudioSettingsStore(state => state.enableWasapiExclusiveOnline);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const currentSongId = currentSong?.id ?? null;
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const playerState = usePlaybackStore(selectDisplayPlayerState);

    const activeSourceRef = useRef<{ source: WasapiSource; key: string; playing: boolean; isUrl: boolean } | null>(null);
    const failedSourcesRef = useRef<Set<string>>(new Set());
    const watchdogRef = useRef<number | null>(null);
    const lastMessageRef = useRef<string | null>(null);
    const lastModeRef = useRef<WasapiMode>('off');
    /** Once an online track fails exclusive, stop trying online for the rest of the session. */
    const onlineSuspendedRef = useRef(false);

    // Publishes the current output mode (for the UI badge) and optionally toasts the change.
    const applyMode = (mode: WasapiMode, toast = false) => {
        const previous = lastModeRef.current;
        if (previous === mode) return;
        lastModeRef.current = mode;
        setWasapiMode(mode);
        if (toast && previous !== 'off') {
            setStatusMessage({
                type: 'info',
                text: i18n.t(mode === 'exclusive' ? 'options.wasapiModeExclusiveToast' : 'options.wasapiModeSharedToast'),
            });
        }
    };

    const clearWatchdog = () => {
        if (watchdogRef.current !== null) {
            window.clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
        }
    };

    // If the engine neither starts nor reports a problem in time, stop trying and restore sound.
    const armWatchdog = (timeoutMs = WATCHDOG_MS) => {
        clearWatchdog();
        watchdogRef.current = window.setTimeout(() => {
            watchdogRef.current = null;
            activeSourceRef.current = null;
            void window.electron?.wasapi?.setRendererMuted(false);
            void window.electron?.wasapi?.stop();
        }, timeoutMs);
    };

    const dropToSharedMode = () => {
        activeSourceRef.current = null;
        applyMode('shared');
        // The engine is not going to play this source: hand the output back to Chromium so the
        // (already running) HTML5 element is audible again instead of leaving it muted.
        void window.electron?.wasapi?.setRendererMuted(false);
        void window.electron?.wasapi?.stop();
        // If exclusive had grabbed the endpoint and left the element stalled, nudge it back.
        const element = audioRef.current;
        if (
            element
            && element.paused
            && usePlaybackStore.getState().playerState === PlayerState.PLAYING
        ) {
            void element.play().catch(() => {});
        }
    };

    // Toggling the setting: enter cleanly, or release the engine and restore Chromium output.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi) return;
        if (enableWasapiExclusive) {
            failedSourcesRef.current = new Set();
            activeSourceRef.current = null;
            onlineSuspendedRef.current = false;
            applyMode('shared');
        } else {
            clearWatchdog();
            void wasapi.stop();
            void wasapi.setRendererMuted(false);
            activeSourceRef.current = null;
            applyMode('off');
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
        // A new endpoint (or switching online support) gets a fresh chance at exclusive.
        onlineSuspendedRef.current = false;
        failedSourcesRef.current = new Set();
        void wasapi.setDevice(wasapiDeviceId);
    }, [enableWasapiExclusive, wasapiDeviceId, enableWasapiExclusiveOnline]);

    // Play / pause / resume routing, issued only on an actual change.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        if (!wasapi || !enableWasapiExclusive) return;

        const song = usePlaybackStore.getState().currentSong;
        if (!song) {
            dropToSharedMode();
            return;
        }

        let cancelled = false;
        void (async () => {
            const resolved = await resolveWasapiSource(
                song,
                audioSrc,
                enableWasapiExclusiveOnline && !onlineSuspendedRef.current,
            );
            if (cancelled) return;
            if (!resolved) {
                dropToSharedMode();
                return;
            }
            const key = `${wasapiDeviceId || 'default'}|${resolved.key}`;
            // Already fell back for this source: stay on shared mode, do not retry.
            if (failedSourcesRef.current.has(key)) return;

            const active = activeSourceRef.current;
            if (active && active.key === key) {
                // Same source: only react to an actual play/pause transition.
                if (playerState === PlayerState.PLAYING && !active.playing) {
                    active.playing = true;
                    armWatchdog();
                    void wasapi.resume(sourceRef(active.source), audioRef.current?.currentTime ?? 0);
                } else if (playerState === PlayerState.PAUSED && active.playing) {
                    active.playing = false;
                    clearWatchdog();
                    void wasapi.pause();
                }
                return;
            }
            if (playerState === PlayerState.PLAYING) {
                // New source: start it and let the HTML5 play until the engine reports `started`.
                // The full source (with bytes for a buffer) is sent once; later reuse drops them.
                activeSourceRef.current = { source: sourceRef(resolved.source), key, playing: true, isUrl: resolved.isUrl };
                void wasapi.setDevice(wasapiDeviceId);
                armWatchdog(resolved.isUrl ? WATCHDOG_URL_MS : WATCHDOG_MS);
                void wasapi.play(resolved.source, 0);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [enableWasapiExclusive, wasapiDeviceId, enableWasapiExclusiveOnline, currentSongId, audioSrc, playerState, audioRef]);

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
                applyMode('exclusive', true);
                void wasapi.setRendererMuted(true);
                if (!event.bitPerfect && lastMessageRef.current !== 'not-bit-perfect') {
                    lastMessageRef.current = 'not-bit-perfect';
                    setStatusMessage({ type: 'info', text: i18n.t('options.wasapiNotBitPerfect') });
                }
                return;
            }
            if (event.type === 'fallback') {
                const active = activeSourceRef.current;
                if (active) {
                    failedSourcesRef.current.add(active.key);
                    // Online exclusive cannot work here: stop trying it for the rest of the session
                    // so we never re-download and stall Chromium's stream again.
                    if (active.isUrl) onlineSuspendedRef.current = true;
                }
                // Fully release the engine and unmute so Chromium's shared output recovers instead
                // of being left contending for the endpoint.
                dropToSharedMode();
                applyMode('shared', true);
                if (lastMessageRef.current !== event.message) {
                    lastMessageRef.current = event.message;
                    setStatusMessage({
                        type: 'info',
                        text: event.message
                            ? `${i18n.t('options.wasapiExclusiveFallback')} (${event.message})`
                            : i18n.t('options.wasapiExclusiveFallback'),
                    });
                }
                return;
            }
            if (event.type === 'ended' || event.type === 'stopped') {
                // Engine no longer owns the output; let the transport be audible again.
                applyMode('shared');
                void wasapi.setRendererMuted(false);
                return;
            }
            if (event.type === 'error') {
                // Any engine-level failure means exclusive output is not live; let shared mode sound.
                applyMode('shared', true);
                void wasapi.setRendererMuted(false);
                if (lastMessageRef.current === event.message) return;
                lastMessageRef.current = event.message;
                setStatusMessage({
                    type: 'error',
                    text: i18n.t('options.wasapiExclusiveError') + ': ' + event.message,
                });
            }
        });
    }, [enableWasapiExclusive, audioRef]);
};
