#!/usr/bin/env bash
# Place empty placeholder files at the paths Tauri's `bundle.externalBin`
# expects, so `cargo build` (and IDE checks) succeed in a fresh
# checkout without first running the heavy PyInstaller build.
#
# - `scripts/build-sidecar.sh` overwrites these with real binaries on
#   `tauri build` (via beforeBuildCommand).
# - The Rust runtime falls back to `uv run` when the bundled binary
#   isn't actually present at the app's resource dir, so dev keeps
#   working even though the stubs are zero-byte.
#
# Wired into `pnpm prepare` so post-`pnpm install` everything just
# compiles.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"

if ! TARGET_TRIPLE="$(rustc -vV 2>/dev/null | awk '/^host:/ {print $2}')"; then
  echo "rustc not on PATH yet — skipping sidecar stubs (cargo install rust first)" >&2
  exit 0
fi

mkdir -p "$BIN_DIR"
for name in wholabass-server ffmpeg; do
  dst="$BIN_DIR/$name-$TARGET_TRIPLE"
  if [[ ! -f "$dst" ]]; then
    : > "$dst"
    chmod +x "$dst"
    echo "stub created: $dst"
  fi
done
