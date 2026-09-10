#!/usr/bin/env bash
# packaging/ffmpeg/build-ffmpeg-wasapi.sh
#
# Builds the audio-focused FFmpeg the WASAPI exclusive output path needs. It matches the flags
# the bundled ffmpeg-audio runtime was built with, plus the 24/32-bit PCM encoders
# (pcm_s24le / pcm_s32le / pcm_f32le / pcm_f64le) that bit-perfect high-res output requires.
#
# Run under MSYS2 MINGW64 on Windows (native build), or under Linux with a mingw-w64 cross
# toolchain and FOLIA_FFMPEG_CROSS_PREFIX=x86_64-w64-mingw32- (the CI path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK="${FOLIA_FFMPEG_WORK:-$REPO_ROOT/.ffmpeg-wasapi-build}"
OUT="${FOLIA_FFMPEG_OUT:-$REPO_ROOT/build/ffmpeg/win-x64}"
VERSION="${FOLIA_FFMPEG_VERSION:-8.1.2}"
FLAGS_FILE="${FOLIA_FFMPEG_FLAGS_FILE:-$SCRIPT_DIR/configure-flags.txt}"

mkdir -p "$WORK"
cd "$WORK"
if [ ! -f "ffmpeg-$VERSION.tar.xz" ]; then
  curl -L --retry 5 -o "ffmpeg-$VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
fi
if [ ! -d "ffmpeg-$VERSION" ]; then
  tar -xf "ffmpeg-$VERSION.tar.xz"
fi
cd "ffmpeg-$VERSION"

FLAGS="$(cat "$FLAGS_FILE")"
CROSS=""
if [ -n "${FOLIA_FFMPEG_CROSS_PREFIX:-}" ]; then
  CROSS="--cross-prefix=${FOLIA_FFMPEG_CROSS_PREFIX}"
fi

# shellcheck disable=SC2086
./configure $FLAGS $CROSS --prefix="$WORK/out" --extra-cflags="-static" --extra-ldflags="-static -static-libgcc"
make -j"$(nproc)"

mkdir -p "$OUT"
cp ffmpeg.exe "$OUT/ffmpeg.exe"
printf '%s\n' "Custom audio-focused FFmpeg $VERSION with pcm_s16le/pcm_s24le/pcm_s32le/pcm_f32le encoders, built by packaging/ffmpeg/build-ffmpeg-wasapi.sh." > "$OUT/WASAPI-FFMPEG.txt"
echo BUILD_OK
