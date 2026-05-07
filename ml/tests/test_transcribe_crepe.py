"""Tests for `pipeline.transcribe_crepe`. The torchcrepe call is mocked."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pretty_midi
import pytest

from pipeline import transcribe_crepe as tr


def _stub_voiced_pattern(
    _path: Path, _model: str
) -> tuple[np.ndarray, np.ndarray, int]:
    """Two notes, A1 (55 Hz, MIDI 33) for 30 frames, then E2 (82 Hz, MIDI 40) for 30 frames."""
    sr = tr.TARGET_SR
    f0 = np.concatenate([np.full(30, 55.0), np.full(30, 82.0)])
    periodicity = np.full(60, 0.9)
    return f0, periodicity, sr


def test_crepe_writes_midi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tr, "_run_torchcrepe", _stub_voiced_pattern)
    bass = tmp_path / "bass.wav"
    bass.write_bytes(b"x")
    out_dir = tmp_path / "out"

    result = tr.transcribe_bass_crepe("abc", bass, out_dir)

    assert result["note_count"] == 2
    assert result["engine"] == "crepe"
    midi_path = out_dir / "bass.mid"
    assert midi_path.is_file()

    midi = pretty_midi.PrettyMIDI(str(midi_path))
    pitches = [int(n.pitch) for inst in midi.instruments for n in inst.notes]
    assert pitches == [33, 40]


def test_crepe_filters_short_blips(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A 1-frame blip (10 ms at TARGET_SR) is filtered out by min_note_sec."""

    def stub(_path: Path, _model: str) -> tuple[np.ndarray, np.ndarray, int]:
        # Blip: one frame voiced, then steady note for 30 frames.
        f0 = np.concatenate([np.array([200.0]), np.full(30, 55.0)])
        periodicity = np.concatenate([np.array([0.9]), np.full(30, 0.9)])
        return f0, periodicity, tr.TARGET_SR

    monkeypatch.setattr(tr, "_run_torchcrepe", stub)
    bass = tmp_path / "bass.wav"
    bass.write_bytes(b"x")
    out_dir = tmp_path / "out"

    result = tr.transcribe_bass_crepe("abc", bass, out_dir)
    assert result["note_count"] == 1


def test_crepe_unvoiced_frames_produce_no_notes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def stub(_path: Path, _model: str) -> tuple[np.ndarray, np.ndarray, int]:
        f0 = np.full(30, 55.0)
        periodicity = np.full(30, 0.1)  # all below default threshold (0.4)
        return f0, periodicity, tr.TARGET_SR

    monkeypatch.setattr(tr, "_run_torchcrepe", stub)
    bass = tmp_path / "bass.wav"
    bass.write_bytes(b"x")
    out_dir = tmp_path / "out"

    result = tr.transcribe_bass_crepe("abc", bass, out_dir)
    assert result["note_count"] == 0


def test_crepe_rejects_unknown_preset(tmp_path: Path) -> None:
    bass = tmp_path / "bass.wav"
    bass.write_bytes(b"x")
    with pytest.raises(ValueError, match="unknown crepe preset"):
        tr.transcribe_bass_crepe("abc", bass, tmp_path / "out", preset="bogus")


def test_crepe_raises_when_bass_missing(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        tr.transcribe_bass_crepe("abc", tmp_path / "missing.wav", tmp_path / "out")
