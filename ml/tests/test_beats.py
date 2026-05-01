"""Tests for `pipeline.beats`. librosa itself is mocked."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline import beats


def _stub_run(_path: Path) -> tuple[float, list[float]]:
    return 124.5, [0.0, 0.5, 1.0, 1.5, 2.0]


def test_track_beats_writes_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(beats, "_run_librosa", _stub_run)

    src = tmp_path / "source.wav"
    src.write_bytes(b"x")
    out_dir = tmp_path / "out"

    result = beats.track_beats("abc", src, out_dir)

    assert result == {"song_id": "abc", "tempo_bpm": 124.5, "beat_count": 5}
    payload = json.loads((out_dir / "beats.json").read_text())
    assert payload["tempo_bpm"] == 124.5
    assert payload["beats"] == [0.0, 0.5, 1.0, 1.5, 2.0]


def test_track_beats_raises_when_source_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        beats.track_beats("abc", tmp_path / "missing.wav", tmp_path / "out")


def test_dispatch_beats_via_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server

    monkeypatch.setattr(beats, "_run_librosa", _stub_run)

    src = tmp_path / "source.wav"
    src.write_bytes(b"x")
    out_dir = tmp_path / "out"

    response = server.dispatch(
        {
            "id": "1",
            "method": "beats",
            "params": {
                "song_id": "abc",
                "source_path": str(src),
                "out_dir": str(out_dir),
            },
        }
    )
    assert response["id"] == "1"
    assert "result" in response, response
    assert response["result"]["beat_count"] == 5
    assert (out_dir / "beats.json").is_file()


def test_beats_rejects_missing_params() -> None:
    import server

    response = server.dispatch(
        {"id": "2", "method": "beats", "params": {"song_id": "x"}}
    )
    assert response["error"]["code"] == "handler_error"
    assert "source_path" in response["error"]["message"]
