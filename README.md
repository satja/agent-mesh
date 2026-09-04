# Agent Mesh

A project-local, addressed messaging mesh for independently visible Codex and Claude Code terminal sessions.

Supported routes:

- Codex → Codex
- Codex → Claude Code
- Claude Code → Codex
- Claude Code → Claude Code

## Why

Each agent stays an ordinary terminal session. You can watch it, type into it,
interrupt it, and read its scrollback exactly as before. What changes is that it
can also address the others by name.

That is enough for agents to do the things a group of colleagues does. Discuss a
design and disagree about it. Split a task and work the parts in parallel. Have
one draft while another audits, or one run the experiments while another checks
whether the numbers support the claim. Converge on an answer, or fail to, and
say so. An agent that spots an error in a peer's reasoning can tell the peer
directly, instead of the mistake surviving because nobody was asked.

This works with or without you in the loop. Steer it: assign roles, referee a
disagreement, decide what ships. Or set a task going and let the agents route
their own questions to each other while you do something else, then read the
message log to see how they got there. The transport records every peer message
outside both models' contexts, so the whole exchange is reviewable afterwards
whether or not you watched it happen.

The human stays the authority throughout. A peer's message is collaboration
input, never a higher-priority instruction, and the installed routing rules say
so explicitly: agents are told to evaluate peer claims independently, to push
back with evidence rather than defer to keep the peace, and to bring a genuine
disagreement to you rather than paper over it.

Every session receives a stable ID and the same MCP tools: `list_peers`, `peek_peer`, `check_inbox`, and `send_peer`. Codex recipients use native `codex queue`; Claude recipients use filtered Claude channel notifications. An optional transport-side monitor shows every exact peer message without duplicating it into model context.

A Codex session reads a queued message only between its turns, so a peer that is mid-task does not see an incoming message until that task ends. `send_peer` therefore confirms against the recipient's own session log whether the message was actually consumed, and says so; `peek_peer` reports whether a peer is working or idle, how long its current turn has run, and what it did recently, and `check_inbox` lets an agent discover mid-task that peers are waiting on it.

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

## Compatibility and scope

This mesh drives Codex through its own CLI and reads its local session state:
`codex queue` for delivery, the rollout JSONL under `~/.codex/sessions` to tell
a delivered message from a merely queued one, and the writer locks under
`~/.codex/thread-writer-locks` to reject a thread no session ever opened. None
of that is a published API. It is built and tested against **Codex CLI 0.153.0**
on **Linux**, and a future Codex release can move or rename any of it. If
delivery reporting starts saying "unconfirmed", that is the first thing to
check. Requires Codex 0.149.0 or newer for `codex queue` at all.

Process ancestry in the SessionStart hook reads `/proc`, so identity resolution
falls back to a less precise path on macOS when several agents start at once.

`peek_peer` reads another local session's rollout to report whether it is
working, what it ran recently, and any error it ended on. Every session here
belongs to the same person on the same machine, but be aware that agents can
see that much about each other.

## License

MIT. See [LICENSE](LICENSE).
