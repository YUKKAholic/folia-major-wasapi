// electron/wasapi/wasapiWorker.cjs
//
// Runs in a Node worker thread so blocking PCM writes and the FFmpeg decode feed never
// stall the Electron main process. Owns the native WASAPI renderer and the FFmpeg child.
// The worker probes the source format itself with music-metadata, so the renderer only has
// to hand it a local file path or a remote audio URL.
//
// Message protocol (main -> worker):
//   { type: 'init', nativePath, ffmpegPath }
//   { type: 'listDevices' }
//   { type: 'play',   source: { filePath } | { url }, startSec }
//   { type: 'pause' }
//   { type: 'resume', source, startSec }
//   { type: 'seek',   source, startSec }
//   { type: 'stop' }
//   { type: 'close' }
//
// Worker -> main:
//   { type: 'listDevices-result', devices }
//   { type: 'started', positionMs, bitPerfect }
//   { type: 'position', positionMs }
//   { type: 'ended', positionMs }
//   { type: 'fallback', message }
//   { type: 'error', message }

'use strict';

const { parentPort } = require('worker_threads');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

let native = null;
let renderer = null;
let ffmpeg = null;
let ffmpegPath = '';
let positionBaseMs = 0;
let playing = false;
let positionTimer = null;
/** Explicit exclusive output device id ('' = system default). */
let deviceId = '';
/** Temp file backing a downloaded URL source, removed when playback moves on. */
let tempSourcePath = null;

const post = (msg) => {
    try {
        parentPort.postMessage(msg);
    } catch {
        // The port may be closed during teardown.
    }
};

const loadNative = (nativePath) => {
    native = require(nativePath);
};

const killFfmpeg = () => {
    if (ffmpeg) {
        try {
            ffmpeg.kill();
        } catch {
            // Already gone.
        }
        ffmpeg = null;
    }
};

const cleanupTemp = () => {
    if (tempSourcePath) {
        try {
            fs.rmSync(tempSourcePath, { force: true });
        } catch {
            // Best effort.
        }
        tempSourcePath = null;
    }
};

const stopRenderer = () => {
    if (renderer) {
        try {
            renderer.stop();
        } catch {
            // Not running.
        }
    }
};

const closeRenderer = () => {
    if (renderer) {
        try {
            renderer.close();
        } catch {
            // Ignore teardown failures.
        }
        renderer = null;
    }
};

const clearPositionTimer = () => {
    if (positionTimer) {
        clearInterval(positionTimer);
        positionTimer = null;
    }
};

const currentPositionMs = () => {
    if (!renderer) return positionBaseMs;
    try {
        return positionBaseMs + renderer.getPositionMs();
    } catch {
        return positionBaseMs;
    }
};

// Streams a remote audio URL to a temp file so the (network-disabled) FFmpeg build can read it.
const downloadToTemp = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let tmp = null;
    try {
        const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
        }
        let ext = '.audio';
        try {
            ext = path.extname(new URL(url).pathname) || ext;
        } catch {
            // Keep the fallback extension.
        }
        tmp = path.join(
            os.tmpdir(),
            `folia-wasapi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
        );
        await pipeline(
            Readable.fromWeb(response.body),
            fs.createWriteStream(tmp),
            { signal: controller.signal },
        );
        return tmp;
    } catch (error) {
        if (tmp) {
            try {
                fs.rmSync(tmp, { force: true });
            } catch {
                // Best effort.
            }
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
};

// Resolves a source descriptor to a local file FFmpeg can read, downloading a URL first.
const resolveSource = async (source) => {
    if (source && typeof source.filePath === 'string' && source.filePath) {
        return { path: source.filePath, temp: false };
    }
    if (source && typeof source.url === 'string' && source.url) {
        const tmp = await downloadToTemp(source.url);
        return { path: tmp, temp: true };
    }
    throw new Error('unsupported audio source');
};

// Probes a local audio file for its native format via music-metadata.
const probeFormat = async (filePath) => {
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true });
    const format = metadata.format || {};
    return {
        sampleRate: Number(format.sampleRate) || 44100,
        channels: Number(format.numberOfChannels) || 2,
        bitsPerSample: Number(format.bitsPerSample) || 16,
    };
};

// Locates the PCM payload inside a WAV header (searches for the 'data' chunk).
const findWavDataOffset = (buf) => {
    if (buf.length < 12) return -1;
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return -1;
    let i = 12;
    while (i + 8 <= buf.length) {
        const id = buf.toString('ascii', i, i + 4);
        const size = buf.readUInt32LE(i + 4);
        if (id === 'data') return i + 8;
        i += 8 + size + (size & 1);
    }
    return -1;
};

// Feeds PCM into the renderer, blocking (in this worker) until accepted.
const feed = (pcm) => {
    if (!renderer || !playing) return;
    let off = 0;
    while (off < pcm.length) {
        const accepted = renderer.writePcm(pcm.subarray(off));
        off += accepted;
        if (accepted === 0) {
            // Ring full: writePcm already blocked with a timeout.
            break;
        }
    }
};

// Maps a source bit depth to the FFmpeg PCM encoder and the exclusive-mode output depth.
const pickCodec = (bitsPerSample) => {
    if (bitsPerSample <= 16) return { codec: 'pcm_s16le', openBits: 16 };
    if (bitsPerSample <= 24) return { codec: 'pcm_s24le', openBits: 24 };
    return { codec: 'pcm_s32le', openBits: 32 };
};

// Decodes `filePath` to PCM (WAV on stdout) and feeds the renderer in real time.
const startDecode = ({ filePath, sampleRate, channels, startSec, codec }) => {
    const args = [
        '-hide_banner', '-nostdin', '-v', 'error',
        ...(startSec > 0 ? ['-ss', String(startSec)] : []),
        '-i', filePath,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', String(channels),
        '-ar', String(sampleRate),
        '-c:a', codec,
        '-f', 'wav', 'pipe:1',
    ];

    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    ffmpeg = child;

    let header = Buffer.alloc(0);
    let dataStarted = false;

    child.stdout.on('data', (chunk) => {
        if (dataStarted) {
            feed(chunk);
            return;
        }
        header = Buffer.concat([header, chunk]);
        const offset = findWavDataOffset(header);
        if (offset >= 0 && header.length >= offset) {
            const pcm = header.subarray(offset);
            dataStarted = true;
            if (pcm.length > 0) feed(pcm);
        }
    });

    child.stderr.on('data', () => {});

    child.once('error', (err) => {
        killFfmpeg();
        // FFmpeg could not run: exclusive playback is impossible, tell the renderer to fall back
        // to the HTML5 (shared-mode) output.
        post({ type: 'fallback', message: err.message });
    });

    child.once('close', () => {
        if (ffmpeg === child) ffmpeg = null;
        if (!playing) return;
        const waitDrain = () => {
            if (!playing) return;
            const buffered = renderer ? renderer.getBufferedBytes() : 0;
            if (buffered <= 0) {
                playing = false;
                clearPositionTimer();
                post({ type: 'ended', positionMs: currentPositionMs() });
                return;
            }
            setTimeout(waitDrain, 100);
        };
        waitDrain();
    });
};

const startPlayback = async ({ source, startSec, deviceId: messageDeviceId }) => {
    killFfmpeg();
    clearPositionTimer();
    closeRenderer();
    cleanupTemp();

    const resolved = await resolveSource(source);
    if (resolved.temp) {
        tempSourcePath = resolved.path;
    }
    const filePath = resolved.path;

    const format = await probeFormat(filePath);
    // Output the source's native bit depth so exclusive playback stays bit-perfect. Requires an
    // FFmpeg build that carries the matching PCM encoders (see packaging/ffmpeg).
    const { codec, openBits } = pickCodec(format.bitsPerSample);
    const bitPerfect = openBits >= format.bitsPerSample;

    const targetDeviceId = typeof messageDeviceId === 'string' ? messageDeviceId : deviceId;
    renderer = new native.FoliaWasapi();
    renderer.openExclusive(targetDeviceId || '', {
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: openBits,
        isFloat: false,
    });

    positionBaseMs = startSec * 1000;
    playing = true;
    renderer.start();
    startDecode({ filePath, sampleRate: format.sampleRate, channels: format.channels, startSec, codec });
    post({ type: 'started', positionMs: positionBaseMs, bitPerfect });

    positionTimer = setInterval(() => {
        if (playing) {
            post({ type: 'position', positionMs: currentPositionMs() });
        }
    }, 250);
};

parentPort.on('message', (msg) => {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
        case 'init':
            loadNative(msg.nativePath);
            ffmpegPath = msg.ffmpegPath;
            post({ type: 'init-result', ok: true });
            break;
        case 'listDevices': {
            try {
                const devices = native.enumerateOutputDevices();
                post({ type: 'listDevices-result', devices });
            } catch (err) {
                post({ type: 'error', message: String(err && err.message || err) });
            }
            break;
        }
        case 'setDevice':
            deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : '';
            break;
        case 'play':
        case 'resume':
        case 'seek':
            startPlayback(msg).catch((err) => {
                playing = false;
                cleanupTemp();
                // Device/format/probe/download failure: fall back to shared mode rather than going silent.
                post({ type: 'fallback', message: String(err && err.message || err) });
            });
            break;
        case 'pause':
            playing = false;
            killFfmpeg();
            stopRenderer();
            clearPositionTimer();
            post({ type: 'paused', positionMs: currentPositionMs() });
            break;
        case 'stop':
            playing = false;
            killFfmpeg();
            stopRenderer();
            clearPositionTimer();
            cleanupTemp();
            post({ type: 'stopped' });
            break;
        case 'close':
            playing = false;
            killFfmpeg();
            clearPositionTimer();
            closeRenderer();
            cleanupTemp();
            post({ type: 'closed' });
            break;
        default:
            break;
    }
});
