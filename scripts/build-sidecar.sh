#!/usr/bin/env bash
# Build the Python sidecar into a single binary and stage it where
# Tauri's `bundle.externalBin` expects to find it.
#
# - Runs PyInstaller against `ml/wholabass-server.spec`.
# - Downloads (or reuses) a static `ffmpeg` so the bundled `yt-dlp`
#   doesn't need a system install on the user's machine.
# - Writes both into `src-tauri/binaries/<name>-<rust-target-triple>`
#   per Tauri's sidecar naming convention.
#
# Hooked into `pnpm tauri build` via `beforeBuildCommand` in
# `tauri.conf.json`. Idempotent: re-running uses PyInstaller's
# incremental cache and skips the ffmpeg download if already present.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ML_DIR="$REPO_ROOT/ml"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"

# Resolve the host's Rust target triple — Tauri appends this to every
# sidecar binary name so the right one ships per platform.
if ! TARGET_TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"; then
  echo "could not determine rust target triple — is rustc on PATH?" >&2
  exit 1
fi
echo "target triple: $TARGET_TRIPLE"

mkdir -p "$BIN_DIR"

# ---------- 1. PyInstaller build ----------
echo "==> PyInstaller: compiling wholabass-server"
cd "$ML_DIR"

# Ensure PyInstaller is available in the uv env. Adding it as a dev
# dep would also work, but installing on-demand keeps `uv sync` fast
# during normal dev.
uv run --with pyinstaller pyinstaller \
  --noconfirm \
  --clean \
  --distpath dist \
  --workpath build \
  wholabass-server.spec

OUT_BIN="$ML_DIR/dist/wholabass-server"
if [[ ! -x "$OUT_BIN" ]]; then
  echo "PyInstaller did not produce $OUT_BIN" >&2
  exit 1
fi

cp "$OUT_BIN" "$BIN_DIR/wholabass-server-$TARGET_TRIPLE"
chmod +x "$BIN_DIR/wholabass-server-$TARGET_TRIPLE"
echo "staged: $BIN_DIR/wholabass-server-$TARGET_TRIPLE"

# ---------- 2. Static ffmpeg ----------
FFMPEG_DEST="$BIN_DIR/ffmpeg-$TARGET_TRIPLE"
# Size check (not just `-x`) — `ensure-sidecar-stubs.sh` drops a
# zero-byte placeholder at this path so cargo's externalBin validation
# passes in dev, and an executable bit alone would have us treat the
# stub as a real ffmpeg and skip the download.
if [[ -x "$FFMPEG_DEST" && $(stat -f%z "$FFMPEG_DEST" 2>/dev/null || stat -c%s "$FFMPEG_DEST") -gt 1048576 ]]; then
  echo "==> ffmpeg already staged at $FFMPEG_DEST — skipping download"
else
  case "$TARGET_TRIPLE" in
    aarch64-apple-darwin)
      # osxexperts.net publishes static arm64 macOS builds; evermeet.cx
      # is Intel-only despite the "latest release" URL implying generic.
      # If a future ffmpeg major bump breaks the URL, drop a working
      # arm64 binary at $FFMPEG_DEST manually and the script's pre-check
      # picks it up next run.
      FFMPEG_URL="https://www.osxexperts.net/ffmpeg71arm.zip"
      EXPECTED_ARCH="arm64"
      ;;
    x86_64-apple-darwin)
      FFMPEG_URL="https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
      EXPECTED_ARCH="x86_64"
      ;;
    *)
      echo "no automatic ffmpeg download configured for $TARGET_TRIPLE" >&2
      echo "drop a static ffmpeg binary at $FFMPEG_DEST and re-run" >&2
      exit 1
      ;;
  esac

  echo "==> ffmpeg: downloading static build from $FFMPEG_URL"
  TMP_ZIP="$(mktemp -t wholabass-ffmpeg.XXXXXX).zip"
  TMP_DIR="$(mktemp -d -t wholabass-ffmpeg.XXXXXX)"
  trap 'rm -rf "$TMP_ZIP" "$TMP_DIR"' EXIT
  curl -fSL "$FFMPEG_URL" -o "$TMP_ZIP"
  (cd "$TMP_DIR" && unzip -q "$TMP_ZIP")
  if [[ ! -x "$TMP_DIR/ffmpeg" ]]; then
    echo "downloaded zip didn't contain an executable ffmpeg" >&2
    exit 1
  fi
  # Validate the downloaded binary's architecture matches the target —
  # the previous URL on evermeet silently served x86_64 binaries when
  # building for arm64 and we shipped a broken bundle.
  GOT_ARCH="$(file -b "$TMP_DIR/ffmpeg" | grep -oE 'arm64|x86_64' | head -1 || echo unknown)"
  if [[ "$GOT_ARCH" != "$EXPECTED_ARCH" ]]; then
    echo "downloaded ffmpeg is $GOT_ARCH but target needs $EXPECTED_ARCH" >&2
    exit 1
  fi
  cp "$TMP_DIR/ffmpeg" "$FFMPEG_DEST"
  chmod +x "$FFMPEG_DEST"
  echo "staged: $FFMPEG_DEST ($GOT_ARCH)"
fi

echo "==> sidecar build complete"
