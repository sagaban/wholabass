"""Tests for `pipeline.transcribe`. basic-pitch is mocked."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from pipeline import transcribe as tr


class _StubMidi:
    def __init__(self) -> None:
        self.written: Path | None = None

    def write(self, path: str) -> None:
        self.written = Path(path)
        Path(path).write_bytes(b"MThd\x00\x00\x00\x06")


def _stub_predict(_audio_path: Path) -> Any:
    midi = _StubMidi()
    notes = [(0.0, 0.5, 40, 0.9, None), (0.5, 1.0, 43, 0.8, None)]
    return ({}, midi, notes)


def test_transcribe_writes_midi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tr, "_run_basic_pitch", _stub_predict)

    bass = tmp_path / "stems" / "bass.wav"
    bass.parent.mkdir(parents=True)
    bass.write_bytes(b"x")
    out_dir = tmp_path / "out"

    result = tr.transcribe_bass("abc", bass, out_dir)

    assert (out_dir / "bass.mid").is_file()
    assert result["song_id"] == "abc"
    assert result["note_count"] == 2
    assert result["midi_path"].endswith("bass.mid")


def test_transcribe_raises_when_bass_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        tr.transcribe_bass("abc", tmp_path / "nope.wav", tmp_path / "out")


def test_dispatch_transcribe_via_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server

    monkeypatch.setattr(tr, "_run_basic_pitch", _stub_predict)

    bass = tmp_path / "bass.wav"
    bass.write_bytes(b"x")
    out_dir = tmp_path / "out"

    response = server.dispatch(
        {
            "id": "1",
            "method": "transcribe",
            "params": {
                "song_id": "abc",
                "bass_path": str(bass),
                "out_dir": str(out_dir),
            },
        }
    )
    assert response["id"] == "1"
    assert "result" in response, response
    assert response["result"]["note_count"] == 2
    assert (out_dir / "bass.mid").is_file()


def test_transcribe_rejects_missing_params() -> None:
    import server

    response = server.dispatch(
        {"id": "2", "method": "transcribe", "params": {"song_id": "x"}}
    )
    assert response["error"]["code"] == "handler_error"
    assert "bass_path" in response["error"]["message"]
