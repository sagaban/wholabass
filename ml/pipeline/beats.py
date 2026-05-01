"""Tempo + per-beat-time tracking via librosa.

Public entry: `track_beats(song_id, source_path, out_dir)`. Writes
`<out_dir>/beats.json` of shape `{tempo_bpm: float, beats: [seconds]}`.
The librosa call is isolated behind `_run_librosa` so tests can stub it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import librosa

import progress


def _run_librosa(source_path: Path) -> tuple[float, list[float]]:
    """Returns (tempo_bpm, beat_times_seconds)."""
    y, sr = librosa.load(str(source_path), mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    return float(tempo), [float(b) for b in beats]


def track_beats(song_id: str, source_path: Path, out_dir: Path) -> dict[str, Any]:
    if not source_path.is_file():
        raise FileNotFoundError(f"source not found: {source_path}")
    out_dir.mkdir(parents=True, exist_ok=True)

    progress.emit(0.0, "tracking_beats")
    tempo_bpm, beats = _run_librosa(source_path)
    progress.emit(95.0, "tracking_beats")

    payload = {"tempo_bpm": tempo_bpm, "beats": beats}
    (out_dir / "beats.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    progress.emit(100.0, "beats_ready")

    return {"song_id": song_id, "tempo_bpm": tempo_bpm, "beat_count": len(beats)}
