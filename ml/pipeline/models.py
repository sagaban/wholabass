"""Status checks for downloadable model weights.

Demucs lazily downloads its `htdemucs` checkpoint into torch's hub cache
on the first call to `get_model()`. basic-pitch's ONNX model ships with
the pip package and never needs a download.
"""

from __future__ import annotations

from pathlib import Path

import torch


def torch_hub_checkpoints_dir() -> Path:
    return Path(torch.hub.get_dir()) / "checkpoints"


def is_demucs_ready() -> bool:
    """True iff at least one checkpoint file is on disk in torch's hub cache.

    Demucs is the only thing in this project that downloads via
    `torch.hub`, so a non-empty checkpoints/ dir is a good proxy for
    "weights have been fetched at least once".
    """
    cache = torch_hub_checkpoints_dir()
    if not cache.exists():
        return False
    return any(p.is_file() for p in cache.iterdir())
