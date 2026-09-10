import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Downloads one pinned Folia FFmpeg release asset for the Electron target and
// stages only its runtime binary plus redistribution metadata for electron-builder.

export const FFMPEG_RELEASE_TAG = "v8.1.2-folia.1";
const RELEASE_BASE_URL = `https://github.com/chthollyphile/folia-ffmpeg-build/releases/download/${FFMPEG_RELEASE_TAG}`;

export const FFMPEG_ASSETS = Object.freeze({
  "linux-x64": {
    archive: "ffmpeg-8.1.2-folia-x86_64-linux-gnu.tar.gz",
    sha256: "f3a5da6e9d9dbfaf4bed50f6f2d39831bb0e7f3fbfd07e0b1b55f668b045256f",
  },
  "linux-arm64": {
    archive: "ffmpeg-8.1.2-folia-arm64-linux-gnu.tar.gz",
    sha256: "ada0c4fafcf74fecceeaee71e367e7b21dd58168b6b6ad182e61c0a332b8a6cb",
  },
  "mac-x64": {
    archive: "ffmpeg-8.1.2-folia-x86_64-apple-macos10.9.tar.gz",
    sha256: "8ea2154fd21020f2032b6d368c2681b6a7b4658042be747bba9e173613544552",
  },
  "mac-arm64": {
    archive: "ffmpeg-8.1.2-folia-arm64-apple-macos11.tar.gz",
    sha256: "7568a12e6f3a028b1846b79ac61a2b3b3c294417701785a9118926209a67e63e",
  },
  "win-x64": {
    archive: "ffmpeg-8.1.2-folia-x86_64-w64-mingw32.tar.gz",
    sha256: "6575c45fc4568e9280281e09d6febf3d23a9a950d9c81ea50e46f5e0ed8fd5e9",
  },
});

// The fork publishes a custom audio-focused FFmpeg (24/32-bit PCM encoders) under this tag. When
// it exists it is preferred for win-x64 so packaged releases support bit-perfect high-res output;
// until then the pinned upstream runtime is used. The archive ships a `.sha256` sidecar, so no hash
// has to be pinned here. See packaging/ffmpeg/build-ffmpeg-wasapi.sh and the build-ffmpeg-wasapi
// workflow.
export const WASAPI_FFMPEG_RELEASE_TAG = "ffmpeg-wasapi";
const WASAPI_RELEASE_BASE_URL = `https://github.com/YUKKAholic/folia-major-wasapi/releases/download/${WASAPI_FFMPEG_RELEASE_TAG}`;
export const WASAPI_FFMPEG_ASSETS = Object.freeze({
  "win-x64": {
    archive: "ffmpeg-8.1.2-folia-wasapi-win-x64.tar.gz",
  },
});

const PLATFORM_NAMES = Object.freeze({
  darwin: "mac",
  linux: "linux",
  win32: "win",
});

export function resolveFfmpegAsset(platform, arch) {
  const osName = PLATFORM_NAMES[platform] ?? platform;
  const key = `${osName}-${arch}`;
  const asset = FFMPEG_ASSETS[key];
  if (!asset)
    throw new Error(`No bundled Folia FFmpeg release for ${platform}/${arch}`);
  return {
    ...asset,
    key,
    osName,
    binaryName: osName === "win" ? "ffmpeg.exe" : "ffmpeg",
  };
}

const sha256File = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

const download = async (url, destination) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
};

const extractArchive = (archive, destination) => {
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`tar failed with exit code ${result.status}`);
};

/**
 * Fetches the fork's custom WASAPI FFmpeg for an arch when its release asset exists. The archive
 * ships a `.sha256` sidecar, so verification needs no pinned hash. Returns the staged directory,
 * or null when the custom asset is not published (caller falls back to upstream).
 */
const prepareWasapiFfmpeg = async (asset, targetDir) => {
  const custom = WASAPI_FFMPEG_ASSETS[asset.key];
  if (!custom) return null;

  const targetBinary = path.join(targetDir, asset.binaryName);
  const markerPath = path.join(targetDir, "WASAPI-FFMPEG.txt");
  try {
    const marker = await readFile(markerPath, "utf8");
    const cachedBinarySha256 = /^Binary SHA-256: ([a-f0-9]{64})$/m.exec(marker)?.[1];
    if (cachedBinarySha256 && (await sha256File(targetBinary)) === cachedBinarySha256) {
      return targetDir;
    }
  } catch {
    // Not cached yet.
  }

  const sidecarResponse = await fetch(
    `${WASAPI_RELEASE_BASE_URL}/${custom.archive}.sha256`,
    { redirect: "follow" },
  );
  if (!sidecarResponse.ok) return null; // not published yet
  const expectedSha256 = (await sidecarResponse.text())
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(`Invalid checksum sidecar for ${custom.archive}`);
  }

  await mkdir(path.dirname(targetDir), { recursive: true });
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "folia-ffmpeg-wasapi-"),
  );
  let stagingDir;
  try {
    const archivePath = path.join(temporaryRoot, custom.archive);
    await download(`${WASAPI_RELEASE_BASE_URL}/${custom.archive}`, archivePath);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Checksum mismatch for ${custom.archive}: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
    extractArchive(archivePath, temporaryRoot);
    // The custom archive carries ffmpeg.exe at its root (unlike the upstream layout).
    const sourceBinary = path.join(temporaryRoot, asset.binaryName);
    const binarySha256 = await sha256File(sourceBinary);
    stagingDir = await mkdtemp(
      path.join(path.dirname(targetDir), `.${asset.key}-${process.pid}-`),
    );
    await copyFile(sourceBinary, path.join(stagingDir, asset.binaryName));
    await rm(targetDir, { recursive: true, force: true });
    await cp(stagingDir, targetDir, { recursive: true });
    // Written last so a failed copy can never be accepted as a valid cache hit.
    await writeFile(
      markerPath,
      `Release: ${WASAPI_FFMPEG_RELEASE_TAG}\nArchive: ${custom.archive}\nArchive SHA-256: ${expectedSha256}\nBinary SHA-256: ${binarySha256}\n`,
    );
    return targetDir;
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

/** Prepares the exact architecture directory consumed by the extraResources FileSet. */
export async function prepareBundledFfmpeg({
  platform = process.platform,
  arch = process.arch,
  outputRoot = path.resolve("build", "ffmpeg"),
} = {}) {
  const asset = resolveFfmpegAsset(platform, arch);
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`Folia FFmpeg checksum is not pinned for ${asset.key}`);
  }

  const targetDir = path.join(outputRoot, asset.key);
  const targetBinary = path.join(targetDir, asset.binaryName);
  // A locally built custom FFmpeg (with the WASAPI 24/32-bit PCM encoders) takes precedence over
  // the pinned upstream asset, so `npm run build:ffmpeg:wasapi` output is what gets packaged.
  if (existsSync(path.join(targetDir, "WASAPI-FFMPEG.txt"))) {
    return targetDir;
  }
  // Prefer the fork's published custom runtime (24/32-bit PCM) over the pinned upstream asset.
  try {
    const wasapiDir = await prepareWasapiFfmpeg(asset, targetDir);
    if (wasapiDir) return wasapiDir;
  } catch (error) {
    console.warn(
      `[ffmpeg] custom WASAPI runtime unavailable, using the pinned upstream build: ${error.message}`,
    );
  }
  const markerPrefix = `Release: ${FFMPEG_RELEASE_TAG}\nArchive: ${asset.archive}\nArchive SHA-256: ${asset.sha256}\n`;
  try {
    const cachedMarker = await readFile(
      path.join(targetDir, "BUNDLE-INFO.txt"),
      "utf8",
    );
    const cachedBinarySha256 = /^Binary SHA-256: ([a-f0-9]{64})$/m.exec(
      cachedMarker,
    )?.[1];
    if (
      cachedMarker.startsWith(markerPrefix) &&
      cachedBinarySha256 &&
      (await sha256File(targetBinary)) === cachedBinarySha256
    )
      return targetDir;
  } catch {
    // Missing/stale output is rebuilt below.
  }

  await mkdir(outputRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "folia-ffmpeg-"));
  let stagingDir;
  try {
    const archivePath = path.join(temporaryRoot, asset.archive);
    await download(`${RELEASE_BASE_URL}/${asset.archive}`, archivePath);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        `Checksum mismatch for ${asset.archive}: expected ${asset.sha256}, got ${actualSha256}`,
      );
    }

    extractArchive(archivePath, temporaryRoot);
    const archiveRoot = path.join(
      temporaryRoot,
      asset.archive.slice(0, -".tar.gz".length),
    );
    const sourceBinary = path.join(archiveRoot, "bin", asset.binaryName);
    const binarySha256 = await sha256File(sourceBinary);
    stagingDir = await mkdtemp(
      path.join(outputRoot, `.${asset.key}-${process.pid}-`),
    );
    await copyFile(sourceBinary, path.join(stagingDir, asset.binaryName));
    if (asset.binaryName === "ffmpeg")
      await chmod(path.join(stagingDir, asset.binaryName), 0o755);
    await cp(
      path.join(archiveRoot, "share", "folia-ffmpeg"),
      path.join(stagingDir, "share", "folia-ffmpeg"),
      { recursive: true },
    );
    await rm(targetDir, { recursive: true, force: true });
    await cp(stagingDir, targetDir, { recursive: true });
    // Written last so a failed copy can never be accepted as a valid cache hit.
    await writeFile(
      path.join(targetDir, "BUNDLE-INFO.txt"),
      `${markerPrefix}Binary SHA-256: ${binarySha256}\n`,
    );
    return targetDir;
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  prepareBundledFfmpeg().then(
    (output) => console.log(`[ffmpeg] prepared ${output}`),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
