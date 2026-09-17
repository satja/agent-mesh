#!/usr/bin/env python3
"""Deliver one peer message through the public Codex ExternalMessage API."""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from openai_codex import Codex, CodexConfig, ExternalMessage


def debug(message: str) -> None:
    if os.environ.get("AGENT_MESH_DEBUG_EXTERNAL"):
        print(message, file=sys.stderr, flush=True)


def fail(message: str) -> None:
    raise ValueError(message)


def status_type(status: object) -> str | None:
    if hasattr(status, "model_dump"):
        value = status.model_dump(by_alias=True)
        if isinstance(value, dict):
            return value.get("type")
    value = getattr(status, "type", None)
    return value if isinstance(value, str) else None


def main() -> None:
    request = json.load(sys.stdin)
    if not isinstance(request, dict):
        fail("request must be a JSON object")

    socket = request.get("socket")
    thread_id = request.get("threadId")
    content = request.get("content")
    if not isinstance(socket, str) or not Path(socket).is_absolute() or ":" in socket:
        fail("invalid local Codex socket path")
    if not isinstance(thread_id, str) or not thread_id:
        fail("threadId must be a nonempty string")
    if not isinstance(content, str) or not content:
        fail("content must be a nonempty string")

    node_bin = os.environ.get("AGENT_MESH_NODE_BIN") or shutil.which("node")
    if not node_bin:
        fail("Node.js executable was not found")
    bridge = Path(__file__).with_name("sdk-stdio-bridge.mjs")

    config = CodexConfig(
        launch_args_override=(
            node_bin,
            str(bridge),
            socket,
        ),
        client_name="agent_mesh",
        client_title="Agent Mesh",
    )
    debug("connecting SDK proxy")
    with Codex(config=config) as codex:
        debug("resuming thread")
        thread = codex.thread_resume(thread_id, include_turns=False)
        debug("reading thread")
        snapshot = thread.read(include_turns=False)
        state = status_type(snapshot.thread.status)
        if state not in {"active", "idle"}:
            fail(
                f"recipient thread is {state or 'unknown'}; relaunch its mesh terminal. "
                "Nothing was sent."
            )
        debug(f"sending ExternalMessage to {state} thread")
        handle = thread.turn(
            ExternalMessage(
                tool_name="peer_message",
                namespace="agent-mesh",
                content=content,
            ),
            source="agent_mesh",
        )
        debug(f"accepted on turn {handle.id}")
        print(
            json.dumps(
                {
                    "turnId": handle.id,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail = f"{type(error).__name__}: {error}"
        if "no rollout found for thread id" in str(error).lower():
            detail = (
                "Nothing was sent. The Codex Python SDK cannot resume a fresh thread "
                "with no rollout; complete one ordinary turn in the recipient first."
            )
        print(detail, file=sys.stderr, flush=True)
        raise SystemExit(1)
