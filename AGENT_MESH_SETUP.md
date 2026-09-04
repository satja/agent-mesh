# Local Codex + Claude agent mesh

This setup supports any combination of independently visible terminal sessions in one project:

- Codex → Codex
- Codex → Claude Code
- Claude Code → Codex
- Claude Code → Claude Code

Every session has a stable name and the same four MCP tools: `list_peers`, `peek_peer`, `check_inbox`, and `send_peer`. Messages are addressed to one recipient by default; broadcast requires the explicit recipient `*`.

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

The hook normally inherits `AGENT_MESH_ID`/`AGENT_MESH_KIND` from the launcher,
but it gets neither when it runs before you have trusted it, or when the session
was started outside the launcher. The launcher therefore also writes a claim
under `.agent-mesh/launch/` that the hook falls back to, so registration does not
depend on the environment. Launching Codex directly leaves no claim; register
that session by relaunching through the launcher.

A registration carries an `mcp_pid` stamped by that session's MCP server, which
is what makes Codex liveness checkable. The hook preserves a live stamp when it
rewrites a record, and the server retries stamping for about 90 seconds if it
connects before the hook has written anything.

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

## Delivery is not instant, and cannot be recalled

`codex queue` accepts a message into the recipient's queue immediately, but a Codex session only reads its queue between turns. A peer running a long task does not see the message until that task finishes, and a message addressed to a thread whose session has exited is accepted and never read at all. Codex reports both cases identically, so `send_peer` checks the recipient's own session log and reports which happened:

```text
Delivered: codex-b consumed it and can see it now.
QUEUED, NOT YET DELIVERED: codex-b did not consume this within 2000 ms ...
```

If the recipient is registered on a thread that no Codex session ever opened, `send_peer` refuses outright and sends nothing, rather than queueing a message that could never be read:

```text
codex-a is registered on thread 01a0675c-..., which no Codex session ever opened ... Nothing was sent.
```

This happens when a launch fails after startup and leaves a stale registration behind. Relaunch that agent with an explicit session id and send again.

Codex offers no way to cancel or edit a queued message, and re-sending queues a duplicate rather than replacing the original. When delivery is reported as queued, wait rather than re-sending, and check what the peer is doing:

```text
peek_peer(agent_id="codex-b")
```

which reports whether that session is working or idle, how long its current or last turn has run, any error it ended on, and its recent activity.

The limit is symmetric, so an agent cannot receive while it is working either. `check_inbox` lets it find out mid-task that someone is waiting:

```text
2 message(s) waiting for you, and they will arrive at your next turn boundary.
  from codex-a, sent 12m ago
  from claude-b, sent 3m ago
```

It reports senders and ages only. The mesh cannot remove an item from Codex's queue, so every message reported here is still delivered normally afterwards; withholding the text is what stops an agent acting on the same request twice. An agent that finds peers waiting should prefer to finish its current task sooner.

Both tools are decision aids, not wait loops. A peer's message is released when that peer's own turn ends, never because someone checked again, so polling `peek_peer` in a loop only burns the caller's turns. A repeated peek that finds the same turn still running is told exactly that instead of being given the full report again. This reads the peer's own session log; it does not interrupt it and does not consume the peer's model context. Codex exposes no way for one session to interrupt another, so a long task can only be waited out.

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
