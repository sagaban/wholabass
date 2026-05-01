"""Progress emitter shared by sidecar handlers and pipeline modules.

The dispatch loop in `server.py` installs a per-request emitter via
`set_emitter(...)`; pipeline code calls `emit(progress, stage)` without
needing to know about the underlying request id or stdout protocol.
"""

from __future__ import annotations

from collections.abc import Callable

Emitter = Callable[[float, str], None]

_emitter: Emitter | None = None


def set_emitter(fn: Emitter) -> None:
    global _emitter
    _emitter = fn


def clear_emitter() -> None:
    global _emitter
    _emitter = None


def emit(progress: float, stage: str) -> None:
    """Emit a progress event if an emitter is installed; otherwise a no-op."""
    if _emitter is not None:
        _emitter(progress, stage)
