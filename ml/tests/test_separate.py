"""Tests for `pipeline.separate`.

The actual Demucs run is mocked — we trust the upstream model. These tests
exercise the orchestration: source loading, on-disk layout, meta.json shape,
error path.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import torch
import torchaudio

from pipeline import separate as sep


@dataclass
class FakeModel:
    samplerate: int = 44100
    audio_channels: int = 2
    # Order intentionally differs from STEM_NAMES to exercise reordering.
    sources: tuple[str, ...] = ("drums", "bass", "other", "vocals")


def _write_sine(path: Path, *, seconds: float = 1.0, sr: int = 44100) -> None:
    n = int(seconds * sr)
    t = torch.arange(n) / sr
    wave = 0.1 * torch.sin(2 * math.pi * 440.0 * t)
    torchaudio.save(str(path), wave.unsqueeze(0), sr)


@pytest.fixture(autouse=True)
def _stub_demucs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Replace model loading + Demucs apply with deterministic fakes."""
    model = FakeModel()
    monkeypatch.setattr(sep, "_load_model", lambda: model)

    def fake_run(_model: Any, wav: torch.Tensor) -> torch.Tensor:
        # Output shape: (n_stems, channels, samples). Use distinct constants per
        # stem so a misordered write is detectable on disk.
        n_stems = len(model.sources)
        channels, samples = wav.shape
        out = torch.zeros((n_stems, channels, samples))
        for i in range(n_stems):
            out[i, :, :] = (i + 1) * 0.01
        return out

    monkeypatch.setattr(sep, "_run_demucs", fake_run)


def test_writes_expected_layout(tmp_path: Path) -> None:
    src = tmp_path / "input.wav"
    _write_sine(src)

    out_dir = tmp_path / "library" / "abc123"

    result = sep.separate_song(
        song_id="abc123",
        source_path=src,
        out_dir=out_dir,
        processing_version=1,
    )

    assert (out_dir / "source.wav").is_file()
    assert (out_dir / "meta.json").is_file()
    for name in sep.STEM_NAMES:
        assert (out_dir / "stems" / f"{name}.wav").is_file()

    assert result["song_id"] == "abc123"
    assert result["stems"] == list(sep.STEM_NAMES)
    assert result["samplerate"] == 44100
    assert result["channels"] == 2
    assert result["duration_sec"] == pytest.approx(1.0, abs=0.05)


def test_meta_json_shape(tmp_path: Path) -> None:
    src = tmp_path / "My Song.wav"
    _write_sine(src)

    out_dir = tmp_path / "library" / "xyz"
    sep.separate_song(
        song_id="xyz",
        source_path=src,
        out_dir=out_dir,
        processing_version=7,
    )

    meta = json.loads((out_dir / "meta.json").read_text())
    assert meta["song_id"] == "xyz"
    assert meta["title"] == "My Song"
    assert meta["source"] == {"kind": "file", "ref": str(src)}
    assert meta["processing_version"] == 7
    assert isinstance(meta["created_at"], float)
    assert meta["duration"] == pytest.approx(1.0, abs=0.05)


def test_ordered_stems_remaps_model_source_order() -> None:
    """The fake model lists sources as drums/bass/other/vocals; STEM_NAMES is
    vocals/drums/bass/other. _ordered_stems must produce indices that remap
    the model's order to ours."""
    fake_sources = ("drums", "bass", "other", "vocals")
    order = sep._ordered_stems(fake_sources)
    # vocals→3, drums→0, bass→1, other→2
    assert order == [3, 0, 1, 2]


def test_stem_files_all_written(tmp_path: Path) -> None:
    """All four canonical stems land on disk regardless of model source order."""
    src = tmp_path / "src.wav"
    _write_sine(src)
    out_dir = tmp_path / "out"

    sep.separate_song(
        song_id="i",
        source_path=src,
        out_dir=out_dir,
        processing_version=1,
    )

    for name in sep.STEM_NAMES:
        wav, _sr = torchaudio.load(str(out_dir / "stems" / f"{name}.wav"))
        assert wav.numel() > 0
        assert torch.isfinite(wav).all()


def test_missing_source_raises(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    with pytest.raises(FileNotFoundError):
        sep.separate_song(
            song_id="x",
            source_path=tmp_path / "nope.wav",
            out_dir=out_dir,
            processing_version=1,
        )


def test_dispatch_separate_via_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The server's `separate` handler should accept params and call into pipeline."""
    import server

    src = tmp_path / "input.wav"
    _write_sine(src)
    out_dir = tmp_path / "library" / "abc"

    response = server.dispatch(
        {
            "id": "1",
            "method": "separate",
            "params": {
                "song_id": "abc",
                "source_path": str(src),
                "out_dir": str(out_dir),
                "processing_version": 1,
            },
        }
    )

    assert response["id"] == "1"
    assert "result" in response, response
    assert response["result"]["song_id"] == "abc"
    assert (out_dir / "stems" / "bass.wav").is_file()


def test_separate_rejects_missing_params() -> None:
    import server

    response = server.dispatch(
        {"id": "2", "method": "separate", "params": {"song_id": "x"}}
    )
    assert response["id"] == "2"
    assert response["error"]["code"] == "handler_error"
    assert "source_path" in response["error"]["message"]
