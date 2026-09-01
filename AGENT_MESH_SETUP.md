# Local Codex + Claude agent mesh

This setup supports any combination of independently visible terminal sessions in one project:

- Codex → Codex
- Codex → Claude Code
- Claude Code → Codex
- Claude Code → Claude Code

Every session has a stable name and the same two MCP tools: `list_peers` and `send_peer`. Messages are addressed to one recipient by default; broadcast requires the explicit recipient `*`.

## Install in a new project

Clone the Agent Mesh repository somewhere permanent. From the new project folder, run the installer by its path:

```sh
node /path/to/agent-mesh/install-agent-mesh.mjs
```

The installer copies the runtime into the project, installs its Node dependencies, runs the transport tests, and safely merges:

- `.mcp.json` for Claude Code
- `.codex/config.toml` for Codex
- `.codex/hooks.json` for Codex identity registration
- `AGENTS.md` and `CLAUDE.md` routing instructions

If the older `codex-bridge` setup is recognized, its configuration and hooks are deactivated. Its files remain on disk, so the migration is non-destructive.

## Launch sessions

Open one terminal per agent in the project. Examples:

```sh
./agent-mesh/start codex codex-a
./agent-mesh/start codex codex-b
./agent-mesh/start claude claude-a
./agent-mesh/start claude claude-b
```

Use only the sessions you need. Two Codex sessions, one of each, or two Claude sessions all use the same installation.

Every Codex launcher invocation supplies a short bootstrap prompt automatically. On the first Codex launch for this project:

1. Trust the project MCP server and the `SessionStart` hook when Codex asks.
2. If the startup hook was skipped before you trusted it, choose either:
   - Run `/clear codex-a` (using that terminal's actual agent ID), then complete one ordinary turn; or
   - Exit and relaunch. The trusted startup hook and automatic bootstrap will then both run.

Codex does not pass `AGENT_MESH_ID`/`AGENT_MESH_KIND` to hook commands, only to
the MCP server. The launcher therefore also writes a claim under
`.agent-mesh/launch/`, and the hook falls back to it, so registration does not
depend on the hook inheriting an environment. Launching Codex directly rather
than through `./agent-mesh/start` leaves no claim; register that session by
relaunching through the launcher.

Codex sessions launched after the hook is trusted need neither `/clear` nor a manual bootstrap. Claude registers itself when its MCP/channel server starts.

### Resuming a session

Resume through the launcher so the session keeps its mesh identity:

```sh
./agent-mesh/start codex codex-a --resume          # picker
./agent-mesh/start codex codex-a --resume --last   # most recent
./agent-mesh/start claude claude-a --resume        # picker
./agent-mesh/start claude claude-a --resume <id>   # by session id
```

Everything after `--resume` is handed to the agent's own resume interface. A
resumed session gets no bootstrap turn.

`codex resume` or `claude --resume` run directly inherit no `AGENT_MESH_ID` or
`AGENT_MESH_KIND`, so the MCP server exits at startup and Codex reports
`MCP startup failed handshaking, connection closed: initialize response`. The
server writes the reason to stderr and to `.agent-mesh/agent-mesh.log`.

To disable the automatic prompt—for example, when supplying your own initial Codex prompt—use:

```sh
./agent-mesh/start codex codex-a --mesh-no-bootstrap
```

Check what is registered:

```sh
npm --prefix agent-mesh run status
```

Each row ends with a liveness verdict. `live` is healthy. `unconfirmed` on a
Codex row means the session registered but its MCP server never connected.
`STALE` means the process behind the registration is gone. An agent that is
**missing entirely** never ran its `SessionStart` hook at all — the symptom is
one-directional traffic, because an unregistered agent can still read its peers'
registrations and send to them while nothing can address it. Look for
`"source":"session-hook"` entries in `.agent-mesh/agent-mesh.log` to see whether
the hook ran and why it declined to register.

## Use it

Ask an agent in ordinary language, for example:

```text
Send codex-b the proposed design and ask it to find failure modes.
```

The agent should call:

```text
send_peer(recipient="codex-b", message="...")
```

When exactly one other peer is registered, `recipient` may be omitted. With multiple peers, name the target. Use `recipient="*"` only for a deliberate broadcast.

Agent messages arrive with a structural envelope:

```text
[From claude agent: claude-a via agent-mesh]
```

The receiving agent answers the human normally and answers another agent through `send_peer`. This separation means a Codex final response no longer needs a marker, and Claude does not need UI keystrokes or `@name` routing.

The transport records each successfully delivered peer message exactly once, outside both models' contexts. To see the complete conversation across every Codex and Claude session in one extra terminal, run:

```sh
./agent-mesh/watch
```

The monitor prints existing history and then follows new messages. To ignore existing history and show only messages sent after the monitor starts, use `./agent-mesh/watch --new`.

## What you can watch

Each agent stays in its own terminal, while the optional monitor shows every exact agent-to-agent message with its sender and recipient. Peer delivery includes only the message the sender deliberately passes to `send_peer`; it does not silently copy all tool calls or hidden reasoning to the other agent. The monitor is transport-side and consumes no model tokens.

## Long agent-to-agent exchanges

The installed `AGENTS.md` and `CLAUDE.md` tell both agents to keep exchanging substantive messages while a requested collaboration is still productive. They should test claims, push back with evidence, and surface unresolved disagreements to you. The exchange stops when it converges, reaches a limit you set, or genuinely needs your decision.

The transport does not itself impose a turn limit. Usage limits and each client runtime still apply.

## Why Claude `@name` is not the transport

Claude Code can name and resume sessions, and its experimental Agent Teams feature has teammate messaging. That is not a documented general API for addressing arbitrary independently launched Claude sessions. The mesh therefore uses an addressed mailbox plus Claude channel notifications for Claude recipients. This is symmetric with the Codex side at the agent level—both call `send_peer`—while each destination uses its reliable native delivery mechanism.

## Runtime files

The generated `.agent-mesh/` directory contains session registrations, the Claude delivery mailbox, the exact message ledger used by the monitor, and diagnostics. It is git-ignored and owned by the transport. Agents should not edit or poll it directly. Because the ledger contains complete peer messages, protect it like other local conversation history.
