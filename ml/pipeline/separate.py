"""Demucs `htdemucs` 4-stem separation.

The single public entry point is `separate_song`. The actual Demucs call is
isolated behind `_run_demucs` so tests can substitute a deterministic stub.
"""

from __future__ import annotations

import json
import math
import threading
import time
import warnings
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import torch
import torchaudio
from demucs.apply import apply_model
from demucs.audio import convert_audio, save_audio
from demucs.pretrained import get_model

import progress

# torchaudio>=2.4 routes save() through TorchCodec which doesn't honour
# demucs's `encoding`/`bits_per_sample` kwargs. The output is fine; the
# warnings are noise for our use case.
warnings.filterwarnings(
    "ignore",
    message=".*'encoding' parameter is not fully supported by TorchCodec.*",
    category=UserWarning,
)
warnings.filterwarnings(
    "ignore",
    message=".*'bits_per_sample' parameter is not directly supported by TorchCodec.*",
    category=UserWarning,
)

MODEL_NAME = "htdemucs"
STEM_NAMES: tuple[str, ...] = ("vocals", "drums", "bass", "other")

_model_cache: Any = None


def _load_model() -> Any:
    global _model_cache
    if _model_cache is None:
        model = get_model(MODEL_NAME)
        model.eval()
        _model_cache = model
    return _model_cache


def _run_demucs(model: Any, wav: torch.Tensor) -> torch.Tensor:
    """Apply Demucs to a (channels, samples) tensor; return (stems, channels, samples).

    Normalization follows the upstream `demucs.separate` reference. Pulled out
    so tests can replace it with a fast deterministic fake.
    """
    ref = wav.mean(0)
    wav_n = (wav - ref.mean()) / ref.std()
    sources = apply_model(model, wav_n[None], device="cpu", progress=False)[0]
    return sources * ref.std() + ref.mean()


def _run_demucs_with_heartbeat(model: Any, wav: torch.Tensor) -> torch.Tensor:
    """Run Demucs while emitting an asymptotic stage="separating" heartbeat.

    Demucs 4.0.1's apply_model exposes no per-step callback, so without a
    heartbeat the bar parks until the call returns. The thread emits an
    ease-out curve capped at ~95%, which leaves headroom for `writing_stems`
    to finish the bar.
    """
    stop = threading.Event()
    start = time.monotonic()
    tau = 30.0  # ~63% of the way at 30s elapsed

    def _tick() -> None:
        while not stop.wait(0.5):
            elapsed = time.monotonic() - start
            pct = 95.0 * (1.0 - math.exp(-elapsed / tau))
            progress.emit(pct, "separating")

    thread = threading.Thread(target=_tick, daemon=True)
    thread.start()
    try:
        return _run_demucs(model, wav)
    finally:
        stop.set()
        thread.join(timeout=1.0)


def _load_source(source_path: Path, samplerate: int, channels: int) -> tuple[torch.Tensor, float]:
    wav, sr = torchaudio.load(str(source_path))
    duration = wav.shape[-1] / float(sr)
    wav = convert_audio(wav, sr, samplerate, channels)  # type: ignore[no-untyped-call]
    return wav, duration


def _write_meta(
    out_dir: Path,
    song_id: str,
    title: str,
    source_ref: str,
    duration_sec: float,
    processing_version: int,
) -> None:
    meta = {
        "song_id": song_id,
        "title": title,
        "source": {"kind": "file", "ref": source_ref},
        "duration": duration_sec,
        "processing_version": processing_version,
        "created_at": time.time(),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def _ordered_stems(model_sources: Iterable[str]) -> list[int]:
    """Return indices into model.sources matching STEM_NAMES order."""
    sources = list(model_sources)
    return [sources.index(name) for name in STEM_NAMES]


def separate_song(
    song_id: str,
    source_path: Path,
    out_dir: Path,
    processing_version: int,
    title: str | None = None,
) -> dict[str, Any]:
    """Run htdemucs on `source_path`; write source.wav, stems/, meta.json under `out_dir`.

    `title` is the user-visible song title (e.g. yt-dlp's video title for
    URL ingests). When omitted we fall back to `source_path.stem`, which is
    the right answer for drag-drop ingests (filename without extension).

    Returns a result envelope describing what landed on disk.
    """
    if not source_path.exists():
        raise FileNotFoundError(f"source not found: {source_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    stems_dir = out_dir / "stems"
    stems_dir.mkdir(exist_ok=True)

    from pipeline.models import is_demucs_ready

    progress.emit(0.0, "downloading_model" if not is_demucs_ready() else "loading_model")
    model = _load_model()

    progress.emit(5.0, "loading_source")
    wav, duration = _load_source(source_path, model.samplerate, model.audio_channels)

    save_audio(wav, str(out_dir / "source.wav"), model.samplerate)

    progress.emit(0.0, "separating")
    sources = _run_demucs_with_heartbeat(model, wav)
    order = _ordered_stems(model.sources)

    progress.emit(90.0, "writing_stems")
    for name, idx in zip(STEM_NAMES, order, strict=True):
        save_audio(sources[idx], str(stems_dir / f"{name}.wav"), model.samplerate)

    final_title = title or source_path.stem
    _write_meta(
        out_dir=out_dir,
        song_id=song_id,
        title=final_title,
        source_ref=str(source_path),
        duration_sec=duration,
        processing_version=processing_version,
    )
    progress.emit(100.0, "done")

    return {
        "song_id": song_id,
        "title": final_title,
        "stems": list(STEM_NAMES),
        "duration_sec": duration,
        "samplerate": int(model.samplerate),
        "channels": int(model.audio_channels),
    }
