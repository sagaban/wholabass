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


def test_correct_doubled_tempo_halves_above_threshold() -> None:
    # librosa often reports 2x the real BPM with beats spaced at the
    # eighth-note grid; halving + decimating recovers the quarter grid.
    tempo, decimated = beats._correct_doubled_tempo(
        199.0, [0.0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8]
    )
    assert tempo == pytest.approx(99.5)
    assert decimated == [0.0, 0.6, 1.2, 1.8]


def test_correct_doubled_tempo_halves_quadrupled() -> None:
    # 320 → 160 (still > threshold? no, threshold is exclusive) → stop. We
    # halve once. 4x doublings shouldn't happen in practice; one pass is enough.
    tempo, decimated = beats._correct_doubled_tempo(320.0, list(range(8)))
    assert tempo == 160.0
    assert decimated == [0, 2, 4, 6]


def test_correct_doubled_tempo_leaves_normal_tempo_alone() -> None:
    tempo, decimated = beats._correct_doubled_tempo(118.0, [0.0, 0.5, 1.0])
    assert tempo == 118.0
    assert decimated == [0.0, 0.5, 1.0]


def test_track_beats_corrects_doubled_tempo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        beats,
        "_run_librosa",
        lambda _p: (199.0, [0.0, 0.3, 0.6, 0.9, 1.2, 1.5]),
    )
    src = tmp_path / "source.wav"
    src.write_bytes(b"x")
    out_dir = tmp_path / "out"
    result = beats.track_beats("abc", src, out_dir)
    assert result["tempo_bpm"] == pytest.approx(99.5)
    assert result["beat_count"] == 3


def test_beats_rejects_missing_params() -> None:
    import server

    response = server.dispatch(
        {"id": "2", "method": "beats", "params": {"song_id": "x"}}
    )
    assert response["error"]["code"] == "handler_error"
    assert "source_path" in response["error"]["message"]
