"""basic-pitch bass MIDI transcription.

Public entry: `transcribe_bass(song_id, bass_path, out_dir)`. Writes
`<out_dir>/bass.mid`. The actual basic-pitch call is isolated behind
`_run_basic_pitch` so tests can stub it.

We force the ONNX backend (`nmp.onnx`) shipped with the package — the
default CoreML model has compatibility issues with the torch version
demucs pulls in.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import basic_pitch

import progress

ONNX_MODEL_PATH = (
    Path(basic_pitch.__file__).parent / "saved_models" / "icassp_2022" / "nmp.onnx"
)


def _run_basic_pitch(audio_path: Path) -> Any:
    """Returns (model_output, pretty_midi.PrettyMIDI, note_events)."""
    from basic_pitch.inference import predict

    return predict(str(audio_path), model_or_model_path=str(ONNX_MODEL_PATH))


def transcribe_bass(song_id: str, bass_path: Path, out_dir: Path) -> dict[str, Any]:
    if not bass_path.is_file():
        raise FileNotFoundError(f"bass stem not found: {bass_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    progress.emit(0.0, "transcribing")

    _, midi, note_events = _run_basic_pitch(bass_path)

    progress.emit(95.0, "transcribing")
    midi_path = out_dir / "bass.mid"
    midi.write(str(midi_path))
    progress.emit(100.0, "transcribed")

    return {
        "song_id": song_id,
        "midi_path": str(midi_path),
        "note_count": len(note_events),
    }
