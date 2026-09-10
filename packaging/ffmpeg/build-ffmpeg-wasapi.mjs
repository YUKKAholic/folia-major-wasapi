// packaging/ffmpeg/build-ffmpeg-wasapi.mjs
//
// Thin wrapper that runs build-ffmpeg-wasapi.sh with a suitable bash (MSYS2 MINGW64 on Windows,
// the system bash elsewhere) so the custom 24-bit-capable FFmpeg lands in build/ffmpeg/<os>-<arch>.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build-ffmpeg-wasapi.sh').replace(/\\/g, '/');

const findBash = () => {
    if (process.platform === 'win32') {
        const candidates = [
            process.env.FOLIA_BASH,
            'C:/msys64/usr/bin/bash.exe',
            'C:/msys64/usr/bin/bash',
        ].filter(Boolean);
        const found = candidates.find((candidate) => existsSync(candidate));
        if (!found) {
            throw new Error(
                'MSYS2 bash not found. Install MSYS2 (mingw-w64 toolchain) or set FOLIA_BASH.',
            );
        }
        return found;
    }
    return 'bash';
};

const env = { ...process.env };
if (process.platform === 'win32') {
    env.MSYSTEM = 'MINGW64';
}

console.log('[ffmpeg:wasapi] building custom FFmpeg (this takes a while)...');
const result = spawnSync(findBash(), ['-lc', `bash "${script}"`], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
