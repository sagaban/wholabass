"""YouTube → `<out_dir>/source.wav` via yt-dlp.

Public entry point: `download_song(song_id, url, out_dir)`.

The actual yt-dlp call is isolated behind `_run_yt_dlp` so tests can
substitute a stub. Requires `ffmpeg` on PATH for audio extraction.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

YT_DLP_OPTS_BASE: dict[str, Any] = {
    "format": "bestaudio/best",
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "postprocessors": [
        {
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }
    ],
}


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
    options = {
        **YT_DLP_OPTS_BASE,
        "outtmpl": str(out_dir / "source.%(ext)s"),
    }
    info = _run_yt_dlp(url, options)
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
