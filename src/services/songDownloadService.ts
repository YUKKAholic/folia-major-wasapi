// src/services/songDownloadService.ts
// Downloads the songs of a playlist/album to files on disk.
//
// Online and Navidrome tracks are streamed by the main process straight to the Downloads/Folia
// folder; local files (already on disk) are copied. The renderer only resolves the playable URL -
// which needs the signed-in provider credentials - and hands it to the main process, so the actual
// transfer and progress happen off the UI thread.

import { getLocalSongs } from './db';
import { omni } from './onlineMusic/omni';
import { getSongResourceCacheKey } from './onlineMusic/resourceKeys';
import { isLocalPlaybackSong, isNavidromePlaybackSong } from '../utils/appPlaybackGuards';
import { toSafePlaybackUrl } from '../utils/appPlaybackHelpers';
import { sanitizeDownloadFileName } from '../utils/downloadFileName';
import { useDownloadStore, setDownloadsVisible, type DownloadItem } from '../stores/useDownloadStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import type { AudioQualityPreference } from '../types/onlineMusic';
import type { SongResult } from '../types';

const DOWNLOAD_CONCURRENCY = 2;

const mimeForExtension = (extension: string): string => {
    switch (extension.toLowerCase()) {
        case '.flac': return 'audio/flac';
        case '.wav': return 'audio/wav';
        case '.m4a':
        case '.mp4': return 'audio/mp4';
        case '.aac': return 'audio/aac';
        case '.ogg': return 'audio/ogg';
        default: return 'audio/mpeg';
    }
};

const isAbsoluteWindowsPath = (value: string): boolean =>
    /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');

const songLabel = (song: SongResult): string => {
    const artists = (song.artists || []).map((artist) => artist?.name).filter(Boolean).join(', ');
    return artists ? `${artists} - ${song.name}` : song.name;
};

const extensionFromPath = (value: string | undefined | null): string => {
    if (!value) return '';
    try {
        const pathname = /^https?:\/\//i.test(value) ? new URL(value).pathname : value;
        const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
        return match ? `.${match[1].toLowerCase()}` : '';
    } catch {
        return '';
    }
};

const resolveLocalFilePath = async (song: SongResult): Promise<string | null> => {
    const songId = (song as SongResult & { localRef?: { songId?: string } }).localRef?.songId;
    if (!songId) return null;
    const songs = await getLocalSongs();
    const record = songs.find((candidate) => candidate.id === songId);
    return record?.filePath ?? null;
};

type ResolvedDownload = {
    url?: string;
    sourcePath?: string;
    fileName: string;
};

const resolveDownload = async (
    song: SongResult,
    quality: AudioQualityPreference,
): Promise<ResolvedDownload | null> => {
    if (isLocalPlaybackSong(song)) {
        const filePath = await resolveLocalFilePath(song);
        if (filePath && isAbsoluteWindowsPath(filePath)) {
            const ext = extensionFromPath(filePath) || '.flac';
            return { sourcePath: filePath, fileName: sanitizeDownloadFileName(`${songLabel(song)}${ext}`) };
        }
        // A folder-granted local file has no OS path; it is already stored by the app.
        return null;
    }

    if (isNavidromePlaybackSong(song)) {
        const streamUrl = (song as SongResult & { navidromeData?: { streamUrl?: string } }).navidromeData?.streamUrl;
        if (!streamUrl) return null;
        const ext = extensionFromPath(streamUrl) || '.mp3';
        return { url: toSafePlaybackUrl(streamUrl) || streamUrl, fileName: sanitizeDownloadFileName(`${songLabel(song)}${ext}`) };
    }

    const source = await omni.getAudioSource(song, quality);
    if (!source?.url) return null;
    const url = toSafePlaybackUrl(source.url) || source.url;
    const ext = extensionFromPath(source.url) || (url.includes('flac') ? '.flac' : '.mp3');
    return { url, fileName: sanitizeDownloadFileName(`${songLabel(song)}${ext}`) };
};

let bridgeReady = false;
const ensureProgressBridge = () => {
    if (bridgeReady) return;
    const bridge = window.electron?.download;
    if (!bridge?.onProgress) return;
    bridgeReady = true;
    bridge.onProgress((progress) => {
        useDownloadStore.getState().patchItem(progress.id, {
            status: progress.status === 'downloading' ? 'downloading' : progress.status,
            received: progress.received,
            total: progress.total,
            ...(progress.name ? { name: progress.name } : {}),
            ...(progress.error ? { error: progress.error } : {}),
            ...(progress.path ? { path: progress.path } : {}),
        });
    });
};

const makeId = (index: number): string =>
    `dl-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Downloads the given songs one batch at a time. Resolves playable sources sequentially (providers
 * rate-limit URL lookups) and transfers files with a small concurrency limit.
 */
export const startSongDownloads = async (
    songs: SongResult[],
    quality: AudioQualityPreference,
): Promise<void> => {
    const bridge = window.electron?.download;
    if (!bridge) return;
    ensureProgressBridge();
    setDownloadsVisible(true);

    const seen = new Set<string>();
    const pending: Array<{ id: string; song: SongResult }> = [];
    songs.forEach((song, index) => {
        const key = String(song.id);
        if (seen.has(key)) return;
        seen.add(key);
        pending.push({ id: makeId(index), song });
    });
    if (pending.length === 0) return;

    const store = useDownloadStore.getState();
    store.upsertItems(pending.map(({ id, song }): DownloadItem => ({
        id,
        songId: String(song.id),
        name: song.name,
        status: 'resolving',
        received: 0,
        total: 0,
    })));

    const ready: Array<{ id: string; resolved: ResolvedDownload; song: SongResult }> = [];
    for (const { id, song } of pending) {
        try {
            const resolved = await resolveDownload(song, quality);
            if (!resolved) {
                useDownloadStore.getState().patchItem(id, {
                    status: 'error',
                    error: 'unavailable',
                });
                continue;
            }
            useDownloadStore.getState().patchItem(id, {
                name: resolved.fileName.replace(/\.[a-z0-9]+$/i, ''),
                status: 'downloading',
            });
            ready.push({ id, resolved, song });
        } catch (error) {
            useDownloadStore.getState().patchItem(id, {
                status: 'error',
                error: String((error as Error)?.message || error),
            });
        }
    }

    let cursor = 0;
    const worker = async () => {
        while (cursor < ready.length) {
            const job = ready[cursor];
            cursor += 1;
            const extension = /\.([a-z0-9]+)$/i.exec(job.resolved.fileName)?.[1] ?? '';
            try {
                const result = await bridge.start({
                    id: job.id,
                    url: job.resolved.url,
                    sourcePath: job.resolved.sourcePath,
                    fileName: job.resolved.fileName,
                    // Seed Folia's media cache for online/Navidrome tracks so they can be played
                    // offline and, crucially, fed to the WASAPI exclusive engine from disk.
                    ...(isLocalPlaybackSong(job.song) ? {} : {
                        cacheKey: getSongResourceCacheKey('audio', job.song),
                        mimeType: mimeForExtension(`.${extension}`),
                        limitBytes: useAudioSettingsStore.getState().mediaCacheLimitGb * 1024 * 1024 * 1024,
                    }),
                });
                useDownloadStore.getState().patchItem(job.id, result.ok
                    ? { status: 'done', path: result.path, name: result.name ?? job.resolved.fileName }
                    : { status: result.canceled ? 'canceled' : 'error', error: result.error });
            } catch (error) {
                useDownloadStore.getState().patchItem(job.id, {
                    status: 'error',
                    error: String((error as Error)?.message || error),
                });
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, ready.length) }, () => worker()),
    );
};

export const cancelSongDownload = async (id: string): Promise<void> => {
    await window.electron?.download?.cancel(id);
};

export const openDownloadDirectory = async (): Promise<{ ok: boolean; error?: string }> => {
    const result = await window.electron?.download?.openDirectory();
    return { ok: Boolean(result?.ok), error: result?.error };
};
