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

Live Codex recipients receive peer content through the public Python SDK
`ExternalMessage` interface. The SDK gives it tool-level authority, below user
and developer instructions, so a peer cannot present its text as something the
human typed or use it to grant approval.

Every session receives a stable ID and the MCP tools `list_peers`, `peek_peer`, and `send_peer`. A Codex session launched with the temporary `--mesh-queue` fallback also receives `check_inbox`; live Codex and Claude sessions do not. Codex recipients use live app-server delivery by default, while Claude recipients use filtered Claude channel notifications. An optional transport-side monitor shows every exact peer message without duplicating it into model context.

In queue fallback mode, a Codex session reads a queued message only between its turns, so a peer that is mid-task does not see an incoming message until that task ends. `send_peer` therefore confirms against the recipient's own session log whether the message was actually consumed, and says so; `peek_peer` reports whether a peer is working or idle, how long its current turn has run, and what it did recently, and `check_inbox` lets an agent discover mid-task that peers are waiting on it.

## Requirements

- Node.js 20 or newer
- npm
- Python 3.10 or newer on macOS or Linux for the Codex Python SDK
- Codex CLI **0.154.0 or newer** for default live delivery.
  The temporary `--mesh-queue` fallback requires **0.149.0 or newer**.
- Claude Code for Claude sessions

## Install into a project

Clone the Agent Mesh repository somewhere permanent. From the new project folder, run the installer by its path:

```sh
cd /path/to/your-project
node /path/to/agent-mesh/install-agent-mesh.mjs
```

The installer copies the runtime into the project, installs its Node dependencies
and a project-local `openai-codex==0.154.0` Python environment, runs the transport
tests, and safely merges:

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
under `.agent-mesh/launch/` that the hook falls back to after verifying launcher
process ancestry on Linux or macOS. An unrelated session cannot adopt that claim.
Launching Codex directly leaves no claim; register
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

## Live Codex delivery (default)

With **Codex CLI 0.154.0 or newer on macOS or Linux**, launch a recipient with:

```sh
./agent-mesh/start codex codex-a
./agent-mesh/start codex codex-a --resume <session-id>
```

You still use the normal Codex terminal. The launcher starts a dedicated local
app-server for that agent, connects the terminal to it, and registers a private
Unix socket for the mesh. No extra terminal, port selection, or manual daemon
management is needed. Closing the terminal stops its backend. Each backend
inherits that agent's mesh identity and environment.

Messages from either Claude or Codex are submitted directly as
`openai_codex.ExternalMessage` objects. The SDK starts a turn when the recipient
is idle or joins its active regular turn atomically. Peer content is stored as a
function-call output with tool-level authority; it is never submitted as user
input. The mesh no longer chooses between `turn/steer` and `turn/start`, and it
never calls `turn/interrupt`.

The Node transport starts the SDK helper from `agent-mesh/.venv` and bridges its
stdio connection to the same private app-server WebSocket used by the visible
terminal. This keeps the public Python API as the source of the message shape
while preserving live delivery to the terminal's active thread.

The SDK bridge filters server requests, including command and file approvals,
so the sending helper cannot answer approvals intended for the human's terminal.
Broadcasts submit to recipients concurrently and report each outcome separately.
Failure to write the local message ledger does not change an accepted delivery
into a failed send; the diagnostic log records the ledger error.

Live delivery reports **acceptance**, not that the model has read the message or
replied. A timeout or lost connection after submission reports an unknown outcome
and does not resend through the queue. Do not retry an uncertain send; wait for
the recipient to respond.
`check_inbox` is not exposed in live mode. It is available only to Codex sessions
launched with `--mesh-queue`.

Live delivery is the default, tested against **Python SDK and CLI 0.154.0**.
`ExternalMessage` is a stable public SDK interface; the shared app-server
transport remains experimental. Launch from the
installed project directory; `--profile`, `--cd`, `--worktree`, and custom
`--remote` options are currently rejected in live mode. Configuration overrides
using `-c`, `--config`, `--enable`, and `--disable` are also passed to the backend.
Backend diagnostics go to `.agent-mesh/<agent-id>-app-server.log`.

To use the temporary queue fallback, close the session and resume with:

```sh
./agent-mesh/start codex codex-a --mesh-queue --resume <session-id>
```

For a new queue-mode session, use `./agent-mesh/start codex codex-a --mesh-queue`.
The launcher never silently falls back if live startup fails. `--mesh-live` remains
a supported explicit alias for the default; combining it with `--mesh-queue` is
an error. Claude's launcher and inbound channel delivery are unchanged.
Existing installations need the installer rerun to copy the new modules and
install the Python SDK and WebSocket dependency. On Windows, use `--mesh-queue`;
the shared live transport currently requires a Unix socket.

## Use it

Ask an agent in ordinary language, for example:

```text
Send codex-b the proposed design and ask it to find failure modes.
```

The agent should call:

```text
send_peer(recipient="codex-b", message="...")
```

When exactly one other peer is registered, `recipient` may be omitted. With multiple peers, name the target. Use `recipient="*"` only for a deliberate broadcast. Broadcast results report successful and failed recipients separately, so one failed destination does not hide deliveries already accepted by others.

Agent messages arrive with a structural envelope:

```text
[From claude agent: claude-a via agent-mesh]
```

The receiving agent answers the human normally and answers registered mesh peers through `send_peer`. Native subagents use their native collaboration tools and normal completion replies. This separation means a Codex final response no longer needs a marker, and Claude does not need UI keystrokes or `@name` routing.

## Queue fallback delivery waits for a turn boundary

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

In queue fallback mode the limit is symmetric, so an agent cannot receive while it is working either. `check_inbox` lets it find out mid-task that someone is waiting:

```text
2 message(s) waiting for you, and they will arrive at your next turn boundary.
  from codex-a, sent 12m ago
  from claude-b, sent 3m ago
```

It reports senders and ages only. The mesh cannot remove an item from Codex's queue, so every message reported here is still delivered normally afterwards; withholding the text is what stops an agent acting on the same request twice. An agent that finds peers waiting should prefer to finish its current task sooner.

Both tools are decision aids, not wait loops. Polling does not accelerate delivery or processing. A repeated peek that finds the same turn still running is told exactly that instead of being given the full report again. This reads the peer's own session log; it does not interrupt it and does not consume the peer's model context.

## Monitor messages

The transport records each successfully delivered peer message exactly once, outside both models' contexts. To see the complete conversation across every Codex and Claude session in one extra terminal, run:

```sh
./agent-mesh/watch
```

The monitor prints existing history and then follows new messages. To ignore existing history and show only messages sent after the monitor starts, use `./agent-mesh/watch --new`.

Each agent stays in its own terminal, while the optional monitor shows every exact agent-to-agent message with its sender and recipient. Peer delivery includes only the message the sender deliberately passes to `send_peer`; it does not silently copy all tool calls or hidden reasoning to the other agent. The monitor is transport-side and consumes no model tokens.

## Long agent-to-agent exchanges

The installed `AGENTS.md` and `CLAUDE.md` tell both agents to keep exchanging substantive messages while a requested collaboration is still productive. They should test claims, push back with evidence, and surface unresolved disagreements to you. The exchange stops when it converges, reaches a limit you set, or genuinely needs your decision.

The transport does not itself impose a turn limit. Usage limits and each client runtime still apply.

## Why Claude `@name` is not the transport

Claude Code can name and resume sessions, and its experimental Agent Teams feature has teammate messaging. That is not a documented general API for addressing arbitrary independently launched Claude sessions. The mesh therefore uses an addressed mailbox plus Claude channel notifications for Claude recipients. This is symmetric with the Codex side at the agent level—both call `send_peer`—while each destination uses its reliable native delivery mechanism.

## Runtime files

The generated `.agent-mesh/` directory contains session registrations, the Claude delivery mailbox, the exact message ledger used by the monitor, and diagnostics. It is git-ignored and owned by the transport. Agents should not edit or poll it directly. Because the ledger contains complete peer messages, protect it like other local conversation history.

## Compatibility and scope

Queue fallback mode drives Codex through its own CLI and reads its local session state:
`codex queue` for delivery, the rollout JSONL under `~/.codex/sessions` to tell
a delivered message from a merely queued one, and the writer locks under
`~/.codex/thread-writer-locks` to reject a thread no session ever opened. None
of that is a published API. It is built and tested against **Codex CLI 0.153.0**
on **Linux**, and a future Codex release can move or rename any of it. If
delivery reporting starts saying "unconfirmed", that is the first thing to
check. Requires Codex 0.149.0 or newer for `codex queue` at all.

Process ancestry in the SessionStart hook reads `/proc`, so identity resolution
falls back to a less precise path on macOS when several agents start at once.

Live delivery uses the public `ExternalMessage` class rather than reproducing
its wire representation in this project. The SDK currently resumes the target
thread before submitting the message, so a deliberately unbootstrapped fresh
session must complete one ordinary turn before it can receive live peer input.

`peek_peer` reads another local session's rollout to report whether it is
working, what it ran recently, and any error it ended on. Every session here
belongs to the same person on the same machine, but be aware that agents can
see that much about each other.

## Test

```sh
npm --prefix agent-mesh ci
python3 -m venv agent-mesh/.venv
agent-mesh/.venv/bin/python -m pip install -r agent-mesh/requirements.txt
npm --prefix agent-mesh test
```

To check live delivery against your installed Codex, including turn races and
approval routing to a subscribed receiving client:

```sh
npm --prefix agent-mesh run test:live
```

This uses an isolated temporary Codex home and a local mock model server, with
no paid model calls. It needs permission to bind local sockets.

## License

MIT. See [LICENSE](LICENSE).
