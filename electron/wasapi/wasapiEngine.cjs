// electron/wasapi/wasapiEngine.cjs
//
// Main-process facade over the WASAPI worker. Resolves the native module and FFmpeg paths,
// owns the worker thread, and exposes a small async API consumed by the IPC handlers.

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { resolveFfmpeg, TRANSCODE_RUNTIME_DIR } = require('../modSystem/ffmpeg.cjs');

const createWasapiEngine = ({ app }) => {
    let worker = null;
    let ready = false;
    let initPromise = null;
    let eventForwarder = null;
    let listDevicesPending = null;
    let ffmpegPath = '';

    // The native addon ships unpacked next to this file.
    const resolveNativePath = () => {
        const dir = __dirname.replace('app.asar', 'app.asar.unpacked');
        return path.join(dir, 'folia_wasapi.node');
    };

    const resolveFfmpegPath = async () => {
        const status = await resolveFfmpeg({
            appGetAppPath: () => app.getAppPath(),
            packagedDirName: TRANSCODE_RUNTIME_DIR,
        });
        if (!status.available || !status.path) {
            throw new Error('FFmpeg is not available');
        }
        return status.path;
    };

    const ensureWorker = async () => {
        if (ready) return;
        if (initPromise) return initPromise;
        initPromise = (async () => {
            ffmpegPath = await resolveFfmpegPath();
            const nativePath = resolveNativePath();
            worker = new Worker(path.join(__dirname, 'wasapiWorker.cjs'));

            const result = new Promise((resolve, reject) => {
                const onMessage = (msg) => {
                    if (!msg || typeof msg.type !== 'string') return;
                    if (msg.type === 'init-result') {
                        worker.off('message', onMessage);
                        ready = true;
                        resolve();
                    } else if (msg.type === 'error') {
                        worker.off('message', onMessage);
                        reject(new Error(msg.message));
                    }
                };
                worker.on('message', onMessage);
            });

            worker.on('message', handleMessage);
            worker.on('error', (err) => {
                if (eventForwarder) eventForwarder({ type: 'error', message: err.message });
            });
            worker.postMessage({ type: 'init', nativePath, ffmpegPath });
            await result;
        })();
        await initPromise;
    };

    const handleMessage = (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'listDevices-result') {
            if (listDevicesPending) {
                listDevicesPending.resolve(msg.devices || []);
                listDevicesPending = null;
            }
            return;
        }
        if (eventForwarder) eventForwarder(msg);
    };

    const listDevices = async () => {
        await ensureWorker();
        return new Promise((resolve, reject) => {
            listDevicesPending = { resolve, reject };
            worker.postMessage({ type: 'listDevices' });
            setTimeout(() => {
                if (listDevicesPending) {
                    listDevicesPending.resolve([]);
                    listDevicesPending = null;
                }
            }, 3000);
        });
    };

    const send = async (msg) => {
        await ensureWorker();
        worker.postMessage(msg);
    };

    const play = (source, startSec) => send({
        type: 'play',
        source,
        startSec: startSec || 0,
    });

    const pause = () => send({ type: 'pause' });
    const resume = (source, startSec) => send({
        type: 'resume',
        source,
        startSec: startSec || 0,
    });
    const seek = (source, startSec) => send({
        type: 'seek',
        source,
        startSec: startSec || 0,
    });
    const stop = () => send({ type: 'stop' });

    const dispose = async () => {
        if (worker) {
            worker.postMessage({ type: 'close' });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await worker.terminate().catch(() => {});
            worker = null;
            ready = false;
            initPromise = null;
        }
    };

    return {
        listDevices,
        play,
        pause,
        resume,
        seek,
        stop,
        dispose,
        setEventForwarder: (fn) => {
            eventForwarder = fn;
        },
    };
};

module.exports = { createWasapiEngine };
