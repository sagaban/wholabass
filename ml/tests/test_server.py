"""Tests for the JSON-RPC dispatch + ping handler.

These do not exercise stdin/stdout — that's covered by the Rust integration
test which spawns the sidecar end-to-end.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

import server


def test_ping_handler_returns_timestamp() -> None:
    result = server.handle_ping({})
    assert "timestamp" in result
    assert isinstance(result["timestamp"], float)
    # Must be close to current time.
    assert abs(result["timestamp"] - time.time()) < 5.0


def test_dispatch_ping() -> None:
    response = server.dispatch({"id": "abc", "method": "ping", "params": {}})
    assert response["id"] == "abc"
    assert "result" in response
    assert "timestamp" in response["result"]


def test_dispatch_unknown_method() -> None:
    response = server.dispatch({"id": "x", "method": "does_not_exist", "params": {}})
    assert response["id"] == "x"
    assert response["error"]["code"] == "unknown_method"


def test_dispatch_missing_id() -> None:
    response = server.dispatch({"method": "ping", "params": {}})
    assert response["error"]["code"] == "bad_request"


def test_dispatch_missing_method() -> None:
    response = server.dispatch({"id": "y", "params": {}})
    assert response["id"] == "y"
    assert response["error"]["code"] == "bad_request"


def test_dispatch_handler_exception() -> None:
    def boom(_params: server.JsonObject) -> server.JsonObject:
        raise RuntimeError("kaboom")

    server.HANDLERS["__test_boom"] = boom
    try:
        response = server.dispatch({"id": "z", "method": "__test_boom", "params": {}})
        assert response["id"] == "z"
        assert response["error"]["code"] == "handler_error"
        assert "kaboom" in response["error"]["message"]
    finally:
        del server.HANDLERS["__test_boom"]


def test_main_loop_roundtrips_via_subprocess() -> None:
    """Spawn the server as a subprocess, send a ping, read the response."""
    server_path = Path(__file__).resolve().parent.parent / "server.py"
    request = {"id": "1", "method": "ping", "params": {}}
    proc = subprocess.run(
        [sys.executable, str(server_path)],
        input=json.dumps(request) + "\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert proc.returncode == 0, proc.stderr
    line = proc.stdout.strip().splitlines()[0]
    response = json.loads(line)
    assert response["id"] == "1"
    assert "result" in response
    assert "timestamp" in response["result"]


def test_main_loop_handles_bad_json() -> None:
    server_path = Path(__file__).resolve().parent.parent / "server.py"
    proc = subprocess.run(
        [sys.executable, str(server_path)],
        input="this is not json\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    line = proc.stdout.strip().splitlines()[0]
    response = json.loads(line)
    assert response["error"]["code"] == "bad_json"


@pytest.mark.parametrize("payload", ["[]", '"hello"', "42"])
def test_main_loop_rejects_non_object(payload: str) -> None:
    server_path = Path(__file__).resolve().parent.parent / "server.py"
    proc = subprocess.run(
        [sys.executable, str(server_path)],
        input=payload + "\n",
        capture_output=True,
        text=True,
        timeout=10,
    )
    line = proc.stdout.strip().splitlines()[0]
    response = json.loads(line)
    assert response["error"]["code"] == "bad_request"
