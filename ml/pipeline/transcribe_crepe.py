"""CREPE-based monophonic bass transcription via `torchcrepe`.

CREPE is a CNN that predicts a single fundamental frequency per audio
frame, ideally suited to monophonic instruments like bass. We feed it
the demucs-isolated bass stem, threshold by per-frame periodicity,
quantise the f0 to MIDI semitones, and group consecutive same-pitch
frames into note events.

Public entry: `transcribe_bass_crepe(song_id, bass_path, out_dir, ...)`.
The torchcrepe call is isolated behind `_run_torchcrepe` so tests can
stub it without loading the model.
"""

from __future__ import annotations

import contextlib
import io
import math
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import pretty_midi
import torch
import torchcrepe

import progress

# 16 kHz keeps the input small enough for CPU and matches CREPE's
# expected sample rate. 10 ms hop = 100 frames/sec, the granularity at
# which we decide note onsets / offsets.
TARGET_SR = 16_000
HOP_LENGTH = 160  # 10 ms at 16 kHz
F0_MIN_HZ = 41.0  # ~E1
F0_MAX_HZ = 524.0  # ~C5

PRESETS: dict[str, dict[str, Any]] = {
    "balanced": {
        "model": "tiny",
        # Per-frame voicing threshold. Frames whose periodicity is below
        # this are treated as silent — anything below is "no note here".
        "voicing_threshold": 0.4,
        "min_note_sec": 0.06,
    },
    # Catch shorter / quieter notes by lowering the gates.
    "sensitive": {
        "model": "tiny",
        "voicing_threshold": 0.25,
        "min_note_sec": 0.04,
    },
}


def _run_torchcrepe(
    audio_path: Path,
    model: str,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], int]:
    """Returns (f0_hz, periodicity, sample_rate). Frames are at HOP_LENGTH samples."""
    # librosa loads at any sample rate; resample to TARGET_SR for CREPE.
    y, _ = librosa.load(str(audio_path), sr=TARGET_SR, mono=True)
    if y.size == 0:
        return np.zeros(0), np.zeros(0), TARGET_SR
    audio = torch.from_numpy(y).unsqueeze(0)
    # torchcrepe.predict prints / warns on stdout in some configs;
    # capture so the JSON-RPC stream stays clean.
    with contextlib.redirect_stdout(io.StringIO()):
        f0, periodicity = torchcrepe.predict(
            audio,
            TARGET_SR,
            HOP_LENGTH,
            F0_MIN_HZ,
            F0_MAX_HZ,
            model=model,
            decoder=torchcrepe.decode.viterbi,
            return_periodicity=True,
            device="cpu",
            batch_size=512,
        )
    return f0.squeeze(0).cpu().numpy(), periodicity.squeeze(0).cpu().numpy(), TARGET_SR


def _hz_to_midi(hz: float) -> int:
    return round(69 + 12 * math.log2(hz / 440.0))


def _frames_to_notes(
    f0: np.ndarray[Any, Any],
    periodicity: np.ndarray[Any, Any],
    sample_rate: int,
    voicing_threshold: float,
    min_note_sec: float,
) -> list[tuple[float, float, int]]:
    """Group consecutive voiced frames sharing a MIDI pitch into notes.

    Returns a list of (start_sec, end_sec, midi_pitch).
    """
    if f0.size == 0:
        return []
    frame_sec = HOP_LENGTH / sample_rate
    notes: list[tuple[float, float, int]] = []
    cur_pitch: int | None = None
    cur_start: int = 0
    for i, (f, p) in enumerate(zip(f0, periodicity, strict=False)):
        voiced = bool(p >= voicing_threshold) and bool(f) and bool(np.isfinite(f))
        pitch = _hz_to_midi(float(f)) if voiced else None
        if pitch != cur_pitch:
            if cur_pitch is not None:
                notes.append((cur_start * frame_sec, i * frame_sec, cur_pitch))
            cur_pitch = pitch
            cur_start = i
    if cur_pitch is not None:
        notes.append((cur_start * frame_sec, len(f0) * frame_sec, cur_pitch))
    # Filter out blips shorter than the minimum note length.
    return [(s, e, p) for (s, e, p) in notes if e - s >= min_note_sec]


def _notes_to_midi(notes: list[tuple[float, float, int]]) -> pretty_midi.PrettyMIDI:
    midi = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=33, name="Bass")  # GM Electric Bass (finger)
    for start, end, pitch in notes:
        if end <= start:
            continue
        instrument.notes.append(
            pretty_midi.Note(velocity=96, pitch=int(pitch), start=start, end=end),
        )
    midi.instruments.append(instrument)
    return midi


def transcribe_bass_crepe(
    song_id: str,
    bass_path: Path,
    out_dir: Path,
    preset: str = "balanced",
) -> dict[str, Any]:
    if not bass_path.is_file():
        raise FileNotFoundError(f"bass stem not found: {bass_path}")
    if preset not in PRESETS:
        raise ValueError(f"unknown crepe preset: {preset}")

    out_dir.mkdir(parents=True, exist_ok=True)
    progress.emit(0.0, "transcribing")

    params = PRESETS[preset]
    f0, periodicity, sr = _run_torchcrepe(bass_path, params["model"])
    progress.emit(80.0, "transcribing")

    notes = _frames_to_notes(
        f0,
        periodicity,
        sr,
        voicing_threshold=params["voicing_threshold"],
        min_note_sec=params["min_note_sec"],
    )
    midi = _notes_to_midi(notes)
    midi_path = out_dir / "bass.mid"
    midi.write(str(midi_path))
    progress.emit(100.0, "transcribed")

    return {
        "song_id": song_id,
        "midi_path": str(midi_path),
        "note_count": len(notes),
        "preset": preset,
        "engine": "crepe",
    }
