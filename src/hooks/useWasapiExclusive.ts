import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { PlayerState, type SongResult } from '../types';
import { getLocalSongs } from '../services/db';
import { isLocalPlaybackSong } from '../utils/appPlaybackGuards';
import { selectDisplayPlayerState, usePlaybackStore } from '../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import { setWasapiMode, type WasapiMode } from '../stores/useWasapiStatusStore';
import { getSongResourceCacheKey } from '../services/onlineMusic/resourceKeys';
import { recoverAudioOutput } from '../services/audioOutputRecovery';
import { currentTime as currentTimeSignal } from '../stores/motionSignals';
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
): Promise<{ source: WasapiSource; key: string; isUrl: boolean } | null> => {
    // Online / Navidrome tracks use exclusive mode once a downloaded/cached copy exists on disk.
    // Downloading seeds Folia's media cache, so a track played from an online playlist - not from
    // the local library - still gets bit-perfect output from that cached file. Without a cached
    // copy they stay on Chromium's shared output (the download-everything path stalls).
    if (!isLocalPlaybackSong(song)) {
        if (!window.electron?.getAudioCachePath) return null;
        try {
            const cached = await window.electron.getAudioCachePath(getSongResourceCacheKey('audio', song));
            if (cached?.path) {
                return { source: { filePath: cached.path }, key: `file:${cached.path}`, isUrl: false };
            }
        } catch {
            // Unsupported key: fall through to shared output.
        }
        return null;
    }
    const filePath = await resolveLocalFilePath(song);
    if (filePath && isAbsoluteWindowsPath(filePath)) {
        return { source: { filePath }, key: `file:${filePath}`, isUrl: false };
    }
    // Folia exposes library files through a File System Access handle, so there is no OS path;
    // hand the engine the blob the player is already using instead.
    return bufferFromAudioSrc(audioSrc, `blob:${audioSrc}`);
};

/** The reusable form of a source: a buffer's bytes are only sent on the first play. */
const sourceRef = (source: WasapiSource): WasapiSource =>
    'kind' in source && source.kind === 'buffer' ? { kind: 'buffer', name: source.name } : source;

export const useWasapiExclusive = (audioRef: RefObject<HTMLAudioElement | null>) => {
    // Diagnostics: mirrored into the worker's wasapi-debug.log so a desync can be traced from the
    // renderer side too (who moved the transport element, and when).
    const rlog = (message: string) => window.electron?.wasapi?.log?.(message);
    const enableWasapiExclusive = useAudioSettingsStore(state => state.enableWasapiExclusive);
    const wasapiDeviceId = useAudioSettingsStore(state => state.wasapiDeviceId);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const currentSongId = currentSong?.id ?? null;
    const audioSrc = usePlaybackStore(state => state.audioSrc);
    const playerState = usePlaybackStore(selectDisplayPlayerState);

    const activeSourceRef = useRef<{ source: WasapiSource; key: string; playing: boolean; isUrl: boolean } | null>(null);
    const failedSourcesRef = useRef<Set<string>>(new Set());
    const watchdogRef = useRef<number | null>(null);
    const lastMessageRef = useRef<string | null>(null);
    const lastModeRef = useRef<WasapiMode>('off');
    /** True while the engine has actually taken the output (muted Chromium). */
    const exclusiveActiveRef = useRef(false);
    /**
     * While exclusive output is live, Chromium's AudioContext loses the endpoint and the transport
     * element's clock stalls, so the progress bar freezes (and a later resume seeks the engine back
     * to the stale element time). We keep the element aligned to the engine's real position and
     * remember the value we wrote so the resulting `seeked` is not mirrored back as a new play.
     */
    const enginePositionMsRef = useRef(0);
    const engineCorrectionSecRef = useRef<number | null>(null);
    /** After a failed attempt, skip exclusive for a moment so it cannot thrash. */
    const exclusiveCooldownUntilRef = useRef(0);
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

    /**
     * Chromium only recreates its audio stream after exclusive mode tore it down when the element
     * is pause+played. Wait until the element has data so an online stream is not aborted mid-buffer,
     * but force it anyway after a short wait so a slow stream is never left permanently silent.
     */
    const rebuildChromiumOutput = () => {
        const element = audioRef.current;
        if (!element) return;
        const wantsPlay = usePlaybackStore.getState().playerState === PlayerState.PLAYING
            || !element.paused;
        if (!wantsPlay) return;
        let done = false;
        const forceRecreate = () => {
            if (done) return;
            done = true;
            element.removeEventListener('canplay', forceRecreate);
            window.clearTimeout(timer);
            try {
                element.pause();
            } catch {
                // ignore
            }
            void element.play().catch(() => {});
        };
        const timer = window.setTimeout(forceRecreate, 2500);
        if (element.readyState >= 3) {
            forceRecreate();
            return;
        }
        element.addEventListener('canplay', forceRecreate, { once: true });
    };

    /**
     * Hands the output back to Chromium. `rebuild` forces a pause+play so Chromium recreates its
     * audio stream after exclusive mode tore it down; it must only run once the endpoint is
     * released (the worker's `stopped`/`ended` events), or Chromium cannot acquire it back.
     */
    const restoreChromiumOutput = (rebuild = false) => {
        void window.electron?.wasapi?.setRendererMuted(false);
        if (!rebuild || !exclusiveActiveRef.current) return;
        exclusiveActiveRef.current = false;
        // Force Chromium's shared output back: exclusive mode invalidated it and the output routine's
        // "same device" guard would otherwise leave the next song silent.
        recoverAudioOutput();
        rebuildChromiumOutput();
    };

    // If the engine neither starts nor reports a problem in time, stop trying and restore sound.
    const armWatchdog = (timeoutMs = WATCHDOG_MS) => {
        clearWatchdog();
        watchdogRef.current = window.setTimeout(() => {
            watchdogRef.current = null;
            activeSourceRef.current = null;
            void window.electron?.wasapi?.stop();
            restoreChromiumOutput(true);
        }, timeoutMs);
    };

    const dropToSharedMode = () => {
        const hadEngine = activeSourceRef.current !== null || exclusiveActiveRef.current;
        activeSourceRef.current = null;
        applyMode('shared');
        // Release the engine and unmute now; the worker's `stopped` event rebuilds Chromium's
        // output once the endpoint is actually free. Skip the stop when the engine never took the
        // output (e.g. an online track on shared mode), so its element is not disturbed.
        if (hadEngine) void window.electron?.wasapi?.stop();
        restoreChromiumOutput(false);
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
            activeSourceRef.current = null;
            exclusiveActiveRef.current = false;
            applyMode('off');
            restoreChromiumOutput(false);
        }
        return () => {
            clearWatchdog();
            void wasapi.stop();
            exclusiveActiveRef.current = false;
            restoreChromiumOutput(false);
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
    }, [enableWasapiExclusive, wasapiDeviceId]);

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
            const resolved = await resolveWasapiSource(song, audioSrc);
            if (cancelled) return;
            if (!resolved) {
                dropToSharedMode();
                return;
            }
            const key = `${wasapiDeviceId || 'default'}|${resolved.key}`;
            // Already fell back for this source: stay on shared mode, do not retry.
            if (failedSourcesRef.current.has(key)) return;
            // A recent attempt failed on this device; keep shared output for a moment so a busy
            // endpoint cannot turn into an exclusive/shared toggle loop.
            if (Date.now() < exclusiveCooldownUntilRef.current) {
                dropToSharedMode();
                return;
            }

            const active = activeSourceRef.current;
            if (active && active.key === key) {
                // Same source: only react to an actual play/pause transition.
                if (playerState === PlayerState.PLAYING && !active.playing) {
                    active.playing = true;
                    armWatchdog();
                    // Resume from the engine's own position, not the stalled element's clock.
                    const resumeSec = enginePositionMsRef.current > 0
                        ? enginePositionMsRef.current / 1000
                        : (audioRef.current?.currentTime ?? 0);
                    void wasapi.resume(sourceRef(active.source), resumeSec);
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
                rlog(`route-new key=${key}`);
                activeSourceRef.current = { source: sourceRef(resolved.source), key, playing: true, isUrl: resolved.isUrl };
                void wasapi.setDevice(wasapiDeviceId);
                armWatchdog(resolved.isUrl ? WATCHDOG_URL_MS : WATCHDOG_MS);
                void wasapi.play(resolved.source, 0);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [enableWasapiExclusive, wasapiDeviceId, currentSongId, audioSrc, playerState, audioRef]);

    // Seek mirroring: the engine restarts at the element's position whenever a seek lands.
    useEffect(() => {
        const wasapi = window.electron?.wasapi;
        const element = audioRef.current;
        if (!wasapi || !enableWasapiExclusive || !element) return;

        const onSeeked = () => {
            rlog(`seeked el=${element.currentTime.toFixed(3)} paused=${element.paused} ended=${element.ended} rs=${element.readyState} corr=${engineCorrectionSecRef.current ?? 'null'} src=${String(element.currentSrc || '').slice(-28)}`);
            // A seek we issued ourselves to keep the stalled element aligned with the engine's real
            // position is not the listener moving the playhead; mirroring it back would restart
            // playback at (almost) the same spot and cut the audio.
            const correction = engineCorrectionSecRef.current;
            if (correction !== null && Math.abs(element.currentTime - correction) < 0.25) {
                engineCorrectionSecRef.current = null;
                return;
            }
            engineCorrectionSecRef.current = null;
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
            if (event.type === 'position') {
                // Exclusive output stalls Chromium's transport (its AudioContext lost the endpoint),
                // so the element's clock freezes. Drive the visible clock straight from the engine so
                // the progress bar follows the audio smoothly, and only snap the element itself when
                // it has drifted far, to keep a later resume close. The seeked that fires is ours.
                enginePositionMsRef.current = event.positionMs;
                const element = audioRef.current;
                if (exclusiveActiveRef.current) {
                    const engineSec = event.positionMs / 1000;
                    currentTimeSignal.set(engineSec);
                    if (element && Math.abs(element.currentTime - engineSec) > 2) {
                        rlog(`engine-correct ${element.currentTime.toFixed(3)} -> ${engineSec.toFixed(3)} (engine ${event.positionMs.toFixed(1)})`);
                        engineCorrectionSecRef.current = engineSec;
                        try {
                            element.currentTime = engineSec;
                        } catch {
                            // Not seekable yet (still loading); the next position tick retries.
                        }
                    }
                }
                return;
            }
            if (event.type === 'paused') {
                enginePositionMsRef.current = event.positionMs;
                return;
            }
            if (event.type === 'started') {
                rlog(`engine-started pos=${event.positionMs.toFixed(1)}`);
                applyMode('exclusive', true);
                exclusiveActiveRef.current = true;
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
                // Give the endpoint a moment before trying exclusive again.
                exclusiveCooldownUntilRef.current = Date.now() + 3000;
                // Fully release the engine and unmute so Chromium's shared output recovers instead
                // of being left contending for the endpoint.
                dropToSharedMode();
                applyMode('shared', true);
                if (lastMessageRef.current !== event.message) {
                    lastMessageRef.current = event.message;
                    // AUDCLNT_E_DEVICE_IN_USE on the same endpoint Chromium plays to: shared and
                    // exclusive cannot coexist, so tell the listener the actionable fix.
                    const isDeviceInUse = /0x8889000a/i.test(event.message || '');
                    setStatusMessage({
                        type: 'info',
                        text: isDeviceInUse
                            ? i18n.t('options.wasapiDeviceConflict')
                            : (event.message
                                ? `${i18n.t('options.wasapiExclusiveFallback')} (${event.message})`
                                : i18n.t('options.wasapiExclusiveFallback')),
                    });
                }
                return;
            }
            if (event.type === 'ended') {
                // The queue continues on the same exclusive stream (the worker kept the endpoint
                // open for reuse); leave the output as it is.
                return;
            }
            if (event.type === 'stopped') {
                // Engine released the endpoint; let the transport be audible again.
                applyMode('shared');
                restoreChromiumOutput(true);
                return;
            }
            if (event.type === 'error') {
                // Any engine-level failure means exclusive output is not live; let shared mode sound.
                applyMode('shared', true);
                restoreChromiumOutput(true);
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
