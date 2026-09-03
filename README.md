# Agent Mesh

A project-local, addressed messaging mesh for independently visible Codex and Claude Code terminal sessions.

Supported routes:

- Codex → Codex
- Codex → Claude Code
- Claude Code → Codex
- Claude Code → Claude Code

Every session receives a stable ID and the same MCP tools: `list_peers`, `peek_peer`, and `send_peer`. Codex recipients use native `codex queue`; Claude recipients use filtered Claude channel notifications. An optional transport-side monitor shows every exact peer message without duplicating it into model context.

A Codex session reads a queued message only between its turns, so a peer that is mid-task does not see an incoming message until that task ends. `send_peer` therefore confirms against the recipient's own session log whether the message was actually consumed, and says so; `peek_peer` reports whether a peer is working or idle, how long its current turn has run, and what it did recently.

## Install into a project

Clone this repository somewhere permanent, then run its installer from the project you want to equip:

```sh
cd /path/to/your-project
node /path/to/agent-mesh/install-agent-mesh.mjs
```

Launch any combination of agents:

```sh
./agent-mesh/start codex codex-a
./agent-mesh/start codex codex-b
./agent-mesh/start claude claude-a
./agent-mesh/start claude claude-b
```

Resume an existing session through the launcher, never directly:

```sh
./agent-mesh/start codex codex-a --resume          # picker
./agent-mesh/start codex codex-a --resume --last   # most recent
./agent-mesh/start claude claude-a --resume        # picker
./agent-mesh/start claude claude-a --resume <id>   # by session id
```

Running `codex resume` or `claude --resume` directly starts the session without
`AGENT_MESH_ID`/`AGENT_MESH_KIND`, so its MCP server refuses to start and the
agent reports a failed MCP handshake.

Watch every exact agent-to-agent message in one additional terminal:

```sh
./agent-mesh/watch
```

See [AGENT_MESH_SETUP.md](./AGENT_MESH_SETUP.md) for the complete setup, trust, bootstrap, routing, monitoring, and multi-agent instructions.

## Requirements

- Node.js 20 or newer
- npm
- Codex CLI **0.149.0 or newer** for Codex sessions. Delivery to a Codex
  recipient uses `codex queue`, which earlier versions do not provide; on an
  older CLI a Codex agent can still send, but messages addressed to it fail.
  The launcher warns at startup and `send_peer` reports the detected version.
- Claude Code for Claude sessions

The installer is project-local and non-destructive: it merges managed configuration sections and preserves unrelated project configuration. Recognized legacy `codex-bridge` configuration is deactivated but not deleted.

## Test

```sh
npm --prefix agent-mesh ci
npm --prefix agent-mesh test
```
