"""Newline-JSON-RPC stdio server for the wholabass Python sidecar.

Protocol (one JSON object per line):

    request : {"id": str, "method": str, "params": dict}
    progress: {"id": str, "progress": float, "stage": str}     # 0..100
    result  : {"id": str, "result": dict}
    error   : {"id": str, "error": {"code": str, "message": str}}

T0 only implements `ping`. Pipeline methods land in later tasks.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

JsonObject = dict[str, Any]
Handler = Callable[[JsonObject], JsonObject]


def _emit(obj: JsonObject) -> None:
    """Write a single JSON object as one line to stdout and flush."""
    sys.stdout.write(json.dumps(obj, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def handle_ping(_params: JsonObject) -> JsonObject:
    return {"timestamp": time.time(), "version": "0.1.0"}


def handle_separate(params: JsonObject) -> JsonObject:
    # Imported lazily so unit tests + `ping` don't pay the torch/demucs import cost.
    from pipeline.separate import separate_song

    song_id = _require_str(params, "song_id")
    source_path = Path(_require_str(params, "source_path"))
    out_dir = Path(_require_str(params, "out_dir"))
    processing_version = _require_int(params, "processing_version")

    return separate_song(
        song_id=song_id,
        source_path=source_path,
        out_dir=out_dir,
        processing_version=processing_version,
    )


def _require_str(params: JsonObject, key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing or empty string param: {key}")
    return value


def _require_int(params: JsonObject, key: str) -> int:
    value = params.get(key)
    if not isinstance(value, int):
        raise ValueError(f"missing or non-int param: {key}")
    return value


HANDLERS: dict[str, Handler] = {
    "ping": handle_ping,
    "separate": handle_separate,
}


def dispatch(request: JsonObject) -> JsonObject:
    """Run the handler for `request` and return a result/error envelope."""
    req_id = request.get("id")
    method = request.get("method")
    params = request.get("params") or {}

    if not isinstance(req_id, str) or not req_id:
        return {"id": "", "error": {"code": "bad_request", "message": "missing id"}}
    if not isinstance(method, str):
        return {"id": req_id, "error": {"code": "bad_request", "message": "missing method"}}

    handler = HANDLERS.get(method)
    if handler is None:
        return {
            "id": req_id,
            "error": {"code": "unknown_method", "message": f"unknown method: {method}"},
        }

    try:
        result = handler(params)
    except Exception as exc:
        return {
            "id": req_id,
            "error": {
                "code": "handler_error",
                "message": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(),
            },
        }
    return {"id": req_id, "result": result}


def main() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"id": "", "error": {"code": "bad_json", "message": str(exc)}})
            continue
        if not isinstance(request, dict):
            _emit({"id": "", "error": {"code": "bad_request", "message": "not an object"}})
            continue
        _emit(dispatch(request))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
