// electron/wasapi/wasapiWorker.cjs
//
// Runs in a Node worker thread so blocking PCM writes and the FFmpeg decode feed never
// stall the Electron main process. Owns the native WASAPI renderer and the FFmpeg child.
// The worker probes the source format itself with music-metadata, so the renderer only has
// to hand it a local file path.
//
// Message protocol (main -> worker):
//   { type: 'init', nativePath, ffmpegPath }
//   { type: 'listDevices' }
//   { type: 'play',   filePath, startSec }
//   { type: 'pause' }
//   { type: 'resume', filePath, startSec }
//   { type: 'seek',   filePath, startSec }
//   { type: 'stop' }
//   { type: 'close' }
//
// Worker -> main:
//   { type: 'listDevices-result', devices }
//   { type: 'started', positionMs, bitPerfect }
//   { type: 'position', positionMs }
//   { type: 'ended', positionMs }
//   { type: 'error', message }

'use strict';

const { parentPort } = require('worker_threads');
const { spawn } = require('child_process');

let native = null;
let renderer = null;
let ffmpeg = null;
let ffmpegPath = '';
let positionBaseMs = 0;
let playing = false;
let positionTimer = null;

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

const startPlayback = async ({ filePath, startSec }) => {
    killFfmpeg();
    clearPositionTimer();
    closeRenderer();

    const format = await probeFormat(filePath);
    // Output the source's native bit depth so exclusive playback stays bit-perfect. Requires an
    // FFmpeg build that carries the matching PCM encoders (see packaging/ffmpeg).
    const { codec, openBits } = pickCodec(format.bitsPerSample);
    const bitPerfect = openBits >= format.bitsPerSample;

    renderer = new native.FoliaWasapi();
    renderer.openExclusive('', {
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
        case 'play':
        case 'resume':
        case 'seek':
            startPlayback(msg).catch((err) => {
                playing = false;
                // Device/format/probe failure: fall back to shared mode rather than going silent.
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
            post({ type: 'stopped' });
            break;
        case 'close':
            playing = false;
            killFfmpeg();
            clearPositionTimer();
            closeRenderer();
            post({ type: 'closed' });
            break;
        default:
            break;
    }
});
