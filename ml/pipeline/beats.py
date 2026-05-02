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


# librosa's beat tracker periodically locks onto the eighth-note grid
# instead of the quarter-note one and reports double the real tempo.
# Anything above this is much more likely a doubling than a real BPM
# for typical pop / rock material; halve until we're back in range.
TEMPO_DOUBLED_THRESHOLD = 160.0


def _correct_doubled_tempo(
    tempo_bpm: float, beats: list[float]
) -> tuple[float, list[float]]:
    """Halve tempo + decimate beats while tempo > threshold."""
    while tempo_bpm > TEMPO_DOUBLED_THRESHOLD and len(beats) > 1:
        tempo_bpm /= 2.0
        beats = beats[::2]
    return tempo_bpm, beats


def track_beats(song_id: str, source_path: Path, out_dir: Path) -> dict[str, Any]:
    if not source_path.is_file():
        raise FileNotFoundError(f"source not found: {source_path}")
    out_dir.mkdir(parents=True, exist_ok=True)

    progress.emit(0.0, "tracking_beats")
    tempo_bpm, beats = _run_librosa(source_path)
    tempo_bpm, beats = _correct_doubled_tempo(tempo_bpm, beats)
    progress.emit(95.0, "tracking_beats")

    payload = {"tempo_bpm": tempo_bpm, "beats": beats}
    (out_dir / "beats.json").write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    progress.emit(100.0, "beats_ready")

    return {"song_id": song_id, "tempo_bpm": tempo_bpm, "beat_count": len(beats)}
