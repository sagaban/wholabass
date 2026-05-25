"""YouTube → `<out_dir>/source.wav` via yt-dlp.

Public entry point: `download_song(song_id, url, out_dir)`.

The actual yt-dlp call is isolated behind `_run_yt_dlp` so tests can
substitute a stub. yt-dlp needs an `ffmpeg` binary for audio
extraction — by default it looks on `PATH`, and a packaged build
should set the `FFMPEG_LOCATION` env var to the bundled binary's
path so the user doesn't need a system install.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import progress

YT_DLP_OPTS_BASE: dict[str, Any] = {
    "format": "bestaudio/best",
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    # Belt-and-suspenders: even if the caller passes a URL with `&list=`
    # we never want to download the whole playlist.
    "noplaylist": True,
    "postprocessors": [
        {
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }
    ],
}


def _ffmpeg_location() -> str | None:
    """Return the bundled ffmpeg path if the Rust sidecar launcher
    pointed us at one, else None (yt-dlp falls back to PATH)."""
    loc = os.environ.get("FFMPEG_LOCATION")
    return loc if loc else None


def _yt_dlp_progress_hook(d: dict[str, Any]) -> None:
    """yt-dlp progress callback → emit normalized 0-100 percent."""
    status = d.get("status")
    if status == "downloading":
        downloaded = d.get("downloaded_bytes") or 0
        total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
        pct = (downloaded / total) * 100 if total else 0.0
        progress.emit(pct, "downloading")
    elif status == "finished":
        progress.emit(100.0, "downloading")
    elif status == "error":
        progress.emit(0.0, "download_error")


def _run_yt_dlp(url: str, options: dict[str, Any]) -> dict[str, Any]:
    """Invoke yt-dlp on a single URL. Returns the extracted info dict."""
    from yt_dlp import YoutubeDL  # type: ignore[import-untyped]

    with YoutubeDL(options) as ydl:
        return ydl.extract_info(url, download=True)  # type: ignore[no-any-return]


def download_song(song_id: str, url: str, out_dir: Path) -> dict[str, Any]:
    """Download `url` audio as `<out_dir>/source.wav`.

    Returns metadata pulled from yt-dlp (title, duration, uploader,
    extractor, original URL). Caller is responsible for routing this
    info into meta.json — the separate stage owns meta.json today.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    progress.emit(0.0, "downloading")
    options = {
        **YT_DLP_OPTS_BASE,
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "progress_hooks": [_yt_dlp_progress_hook],
    }
    ff = _ffmpeg_location()
    if ff:
        options["ffmpeg_location"] = ff
    info = _run_yt_dlp(url, options)
    progress.emit(100.0, "downloading")
    target = out_dir / "source.wav"
    if not target.is_file():
        raise FileNotFoundError(f"yt-dlp ran but {target} is missing")
    return {
        "song_id": song_id,
        "title": info.get("title", song_id),
        "duration": float(info.get("duration", 0) or 0),
        "uploader": info.get("uploader"),
        "url": info.get("webpage_url", url),
        "extractor": info.get("extractor"),
    }
