"""Bass-stem onset detection.

Used by the frontend's auto-match flow to find when the bass first
plays in the demucs-separated stem, which is the correct anchor for
aligning an uploaded MIDI to the audio (the song's first detected beat
fires regardless of whether the bass is playing yet).

`_run_librosa` is the test seam.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import librosa
import numpy as np


def _run_librosa(bass_path: Path) -> list[float]:
    """Return all detected onset times (seconds) in the bass stem."""
    y, sr = librosa.load(str(bass_path), mono=True)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    return [float(t) for t in np.atleast_1d(onsets)]


# Drop very-early onsets that are almost certainly leakage / noise from
# the demucs separation rather than a real first bass note.
EARLY_NOISE_GUARD_SEC = 0.05


def find_bass_first_onset(bass_path: Path) -> float | None:
    """First plausible bass onset, or None if the stem is silent / unreadable."""
    if not bass_path.is_file():
        return None
    onsets = _run_librosa(bass_path)
    for t in onsets:
        if t >= EARLY_NOISE_GUARD_SEC:
            return t
    return None


def find_bass_onsets(bass_path: Path) -> list[float]:
    """Every onset detected in the bass stem (seconds). Empty when missing."""
    if not bass_path.is_file():
        return []
    return [t for t in _run_librosa(bass_path) if t >= EARLY_NOISE_GUARD_SEC]


def bass_first_onset(song_id: str, bass_path: Path) -> dict[str, Any]:
    """Sidecar entry point. Returns onset_sec (or null when undetermined)."""
    onset = find_bass_first_onset(bass_path)
    return {"song_id": song_id, "onset_sec": onset}


def bass_onsets(song_id: str, bass_path: Path) -> dict[str, Any]:
    """Sidecar entry. Returns the full list of bass-stem onset times."""
    return {"song_id": song_id, "onsets_sec": find_bass_onsets(bass_path)}


def find_stem_onsets(stem_path: Path) -> list[float]:
    """Onsets for any stem (drums, etc.). Empty when missing / unreadable."""
    if not stem_path.is_file():
        return []
    return [t for t in _run_librosa(stem_path) if t >= EARLY_NOISE_GUARD_SEC]


def drum_onsets(song_id: str, drums_path: Path) -> dict[str, Any]:
    """Sidecar entry. Returns drum-stem onsets — the song's pulse."""
    return {"song_id": song_id, "onsets_sec": find_stem_onsets(drums_path)}
