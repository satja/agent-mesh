# Agent Mesh

A project-local, addressed messaging mesh for independently visible Codex and Claude Code terminal sessions.

Supported routes:

- Codex → Codex
- Codex → Claude Code
- Claude Code → Codex
- Claude Code → Claude Code

Every session receives a stable ID and the same MCP tools: `list_peers` and `send_peer`. Codex recipients use native `codex queue`; Claude recipients use filtered Claude channel notifications. An optional transport-side monitor shows every exact peer message without duplicating it into model context.

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

Watch every exact agent-to-agent message in one additional terminal:

```sh
./agent-mesh/watch
```

See [AGENT_MESH_SETUP.md](./AGENT_MESH_SETUP.md) for the complete setup, trust, bootstrap, routing, monitoring, and multi-agent instructions.

## Requirements

- Node.js 20 or newer
- npm
- Codex CLI for Codex sessions
- Claude Code for Claude sessions

The installer is project-local and non-destructive: it merges managed configuration sections and preserves unrelated project configuration. Recognized legacy `codex-bridge` configuration is deactivated but not deleted.

## Test

```sh
npm --prefix agent-mesh ci
npm --prefix agent-mesh test
```
