"""Tests for `pipeline.download`. yt-dlp itself is mocked."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from pipeline import download as dl


def _make_fake_run(target_subpath: str = "source.wav", info: dict[str, Any] | None = None):
    """Build a stub _run_yt_dlp that "downloads" by writing a tiny wav."""
    info = info or {
        "title": "Stubbed",
        "duration": 12.5,
        "webpage_url": "https://yt.example/v=ABC",
        "uploader": "Test",
        "extractor": "youtube",
    }

    def fake(url: str, options: dict[str, Any]) -> dict[str, Any]:
        # outtmpl is a string formatted by yt-dlp; we simulate the wav landing.
        outtmpl = options["outtmpl"]
        out_dir = Path(outtmpl).parent
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / target_subpath).write_bytes(b"RIFF....WAVEfmt ")
        return {**info, "_url": url, "_options": options}

    return fake


def test_download_writes_source_wav_and_returns_meta(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "_run_yt_dlp", _make_fake_run())

    out_dir = tmp_path / "library" / "abc123"
    info = dl.download_song("abc123", "https://yt.example/v=ABC", out_dir)

    assert (out_dir / "source.wav").is_file()
    assert info["song_id"] == "abc123"
    assert info["title"] == "Stubbed"
    assert info["duration"] == 12.5
    assert info["url"] == "https://yt.example/v=ABC"
    assert info["extractor"] == "youtube"


def test_download_raises_when_yt_dlp_doesnt_produce_wav(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Stub that "succeeds" but writes nothing.
    def silent(url: str, options: dict[str, Any]) -> dict[str, Any]:
        return {"title": "x", "duration": 0}

    monkeypatch.setattr(dl, "_run_yt_dlp", silent)

    with pytest.raises(FileNotFoundError):
        dl.download_song("abc", "https://yt.example/v=Z", tmp_path / "x")


def test_download_passes_url_and_outtmpl_to_yt_dlp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: dict[str, Any] = {}

    def capture(url: str, options: dict[str, Any]) -> dict[str, Any]:
        seen["url"] = url
        seen["options"] = options
        out_dir = Path(options["outtmpl"]).parent
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "source.wav").write_bytes(b"x")
        return {"title": "ok", "duration": 1}

    monkeypatch.setattr(dl, "_run_yt_dlp", capture)

    out_dir = tmp_path / "abc"
    dl.download_song("abc", "https://yt.example/v=DEF", out_dir)

    assert seen["url"] == "https://yt.example/v=DEF"
    assert seen["options"]["outtmpl"] == str(out_dir / "source.%(ext)s")
    pps = seen["options"]["postprocessors"]
    assert any(p["key"] == "FFmpegExtractAudio" and p["preferredcodec"] == "wav" for p in pps)


def test_dispatch_download_via_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(dl, "_run_yt_dlp", _make_fake_run())

    out_dir = tmp_path / "library" / "abc"
    response = server.dispatch(
        {
            "id": "1",
            "method": "download",
            "params": {
                "song_id": "abc",
                "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "out_dir": str(out_dir),
            },
        }
    )
    assert response["id"] == "1"
    assert "result" in response, response
    assert response["result"]["song_id"] == "abc"
    assert (out_dir / "source.wav").is_file()


def test_download_rejects_missing_params() -> None:
    import server

    response = server.dispatch(
        {"id": "2", "method": "download", "params": {"song_id": "x"}}
    )
    assert response["error"]["code"] == "handler_error"
    assert "url" in response["error"]["message"]
