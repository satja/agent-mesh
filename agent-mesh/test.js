#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  confirmConsumption,
  peekSession,
  describeDelivery,
  searchNeedle,
} = await import("./queue-status.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const project = mkdtempSync(join(tmpdir(), "agent-mesh-test-"));
const hook = join(here, "session-hook.js");
const serverPath = join(here, "server.js");
const startPath = join(here, "start");
const statusPath = join(here, "status.js");
const watchPath = join(here, "watch");
const queueLog = join(project, "queue.jsonl");
const messageLog = join(project, ".agent-mesh", "messages.jsonl");
const fakeCodex = join(project, "fake-codex");
const launchLog = join(project, "launch.json");
const fakeLauncherCodex = join(project, "fake-launcher-codex");
const children = [];

writeFileSync(
  fakeCodex,
  "#!/usr/bin/env node\n" +
    "const fs = require('node:fs');\n" +
    "fs.appendFileSync(process.env.AGENT_MESH_TEST_QUEUE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
    "process.stdout.write('Queued message test-message for thread test-thread.\\n');\n",
);
chmodSync(fakeCodex, 0o755);
writeFileSync(
  fakeLauncherCodex,
  "#!/usr/bin/env node\n" +
    "const fs = require('node:fs');\n" +
    "fs.writeFileSync(process.env.AGENT_MESH_TEST_LAUNCH_LOG, JSON.stringify({args: process.argv.slice(2), id: process.env.AGENT_MESH_ID, kind: process.env.AGENT_MESH_KIND}));\n",
);
chmodSync(fakeLauncherCodex, 0o755);
const fakeOldCodex = join(project, "fake-old-codex");
writeFileSync(
  fakeOldCodex,
  "#!/usr/bin/env node\n" +
    "if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.144.4\\n'); process.exit(0); }\n" +
    "process.stderr.write(\"error: unexpected argument '--thread' found\\n\\nUsage: codex [OPTIONS] [PROMPT]\\n\");\n" +
    "process.exit(2);\n",
);
chmodSync(fakeOldCodex, 0o755);
const fakeClaude = join(project, "fake-claude");
writeFileSync(
  fakeClaude,
  "#!/usr/bin/env node\n" +
    "const fs = require('node:fs');\n" +
    "fs.writeFileSync(process.env.AGENT_MESH_TEST_LAUNCH_LOG, JSON.stringify({args: process.argv.slice(2)}));\n",
);
chmodSync(fakeClaude, 0o755);

function launchArgs(agentKind, agentId, extraArgs, bin) {
  const result = spawnSync(process.execPath, [startPath, agentKind, agentId, ...extraArgs], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      [agentKind === "codex" ? "AGENT_MESH_CODEX_BIN" : "AGENT_MESH_CLAUDE_BIN"]: bin,
      AGENT_MESH_TEST_LAUNCH_LOG: launchLog,
    },
  });
  assert(result.status === 0, result.stderr || "launcher failed");
  return JSON.parse(readFileSync(launchLog, "utf8")).args;
}

function registerCodex(agentId, sessionId) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: project,
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_MESH_ID: agentId,
      AGENT_MESH_KIND: "codex",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || "registration hook failed");
}

function registerCodexWithoutEnv(sessionId) {
  const env = { ...process.env };
  delete env.AGENT_MESH_ID;
  delete env.AGENT_MESH_KIND;
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: project,
    }),
    encoding: "utf8",
    env,
  });
}

function sessionRecord(agentId) {
  return JSON.parse(
    readFileSync(join(project, ".agent-mesh", "sessions", `${agentId}.json`), "utf8"),
  );
}

class McpProcess {
  constructor(agentId, kind, extraEnv = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = "";
    this.child = spawn(process.execPath, [serverPath], {
      cwd: project,
      env: {
        ...process.env,
        AGENT_MESH_ID: agentId,
        AGENT_MESH_KIND: kind,
        AGENT_MESH_CWD: project,
        AGENT_MESH_CODEX_BIN: fakeCodex,
        AGENT_MESH_TEST_QUEUE_LOG: queueLog,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(this.child);
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      if (process.env.AGENT_MESH_TEST_STDERR === "1") process.stderr.write(chunk);
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        this.notifications.push(message);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-mesh-test", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  call(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolveWait();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        rejectWait(new Error("timed out waiting for channel notification"));
      }
    }, 25);
  });
}

function pass(label) {
  process.stdout.write(`PASS  ${label}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanup() {
  for (const child of children) child.kill();
  rmSync(project, { recursive: true, force: true });
}

const timeout = setTimeout(() => {
  cleanup();
  process.stderr.write("FAIL  agent mesh test timed out\n");
  process.exit(1);
}, 10000);

try {
  mkdirSync(join(project, ".agent-mesh"), { recursive: true });
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { "agent-mesh": { command: "node" } } }),
  );
  writeFileSync(join(project, ".codex", "config.toml"), "[mcp_servers.agent-mesh]\n");
  const launch = spawnSync(process.execPath, [startPath, "codex", "codex-launch"], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_MESH_CODEX_BIN: fakeLauncherCodex,
      AGENT_MESH_TEST_LAUNCH_LOG: launchLog,
    },
  });
  assert(launch.status === 0, launch.stderr || "launcher failed");
  const launchData = JSON.parse(readFileSync(launchLog, "utf8"));
  assert(launchData.id === "codex-launch" && launchData.kind === "codex", "launcher identity missing");
  assert(launchData.args[0] === "--no-alt-screen", "launcher display option missing");
  assert(
    launchData.args.at(-1).startsWith("Agent-mesh bootstrap:"),
    "automatic bootstrap prompt missing",
  );
  pass("Codex launcher identity and automatic bootstrap turn");

  registerCodex("codex-a", "session-a");
  registerCodex("codex-b", "session-b");
  pass("Codex SessionStart identity registration");

  const claudeB = new McpProcess("claude-b", "claude");
  await claudeB.initialize();
  const codexA = new McpProcess("codex-a", "codex");
  await codexA.initialize();
  const claudeA = new McpProcess("claude-a", "claude");
  const initClaudeA = await claudeA.initialize();
  assert(
    initClaudeA.capabilities?.experimental?.["claude/channel"] !== undefined,
    "Claude channel capability was not declared",
  );

  const tools = await codexA.request("tools/list", {});
  const names = tools.tools.map((tool) => tool.name);
  assert(
    names.includes("list_peers") && names.includes("send_peer") && names.includes("peek_peer"),
    `missing tools: ${names.join(", ")}`,
  );
  const listed = await codexA.call("list_peers", {});
  const peerData = JSON.parse(listed.content[0].text);
  assert(peerData.peers.some((peer) => peer.agent_id === "claude-b"), "Claude peer missing");
  pass("Shared MCP discovery for Codex and Claude peers");

  const sourceResult = await codexA.call("send_peer", {
    recipient: "codex-b",
    message: "codex to codex",
  });
  assert(
    !sourceResult.content[0].text.includes("codex to codex"),
    "send_peer echoed the message back into the source context",
  );
  await codexA.call("send_peer", {
    recipient: "claude-b",
    message: "codex to claude",
  });
  await claudeA.call("send_peer", {
    recipient: "codex-b",
    message: "claude to codex",
  });
  await claudeA.call("send_peer", {
    recipient: "claude-b",
    message: "claude to claude",
  });

  await waitFor(
    () =>
      claudeB.notifications.filter(
        (item) => item.method === "notifications/claude/channel",
      ).length >= 2,
  );

  const messageRecords = readFileSync(messageLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(messageRecords.length === 4, `expected 4 monitored messages, got ${messageRecords.length}`);
  assert(
    messageRecords.some(
      (record) =>
        record.sender_id === "codex-a" &&
        record.recipient_id === "claude-b" &&
        record.message === "codex to claude",
    ),
    "exact transported message missing from monitor ledger",
  );
  const monitor = spawnSync(process.execPath, [watchPath, "--once"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, AGENT_MESH_CWD: project },
  });
  assert(monitor.status === 0, monitor.stderr || "message monitor failed");
  assert(
    monitor.stdout.includes("codex-a (codex) -> claude-b (claude)") &&
      monitor.stdout.includes("codex to claude"),
    "message monitor did not render exact ledger content",
  );
  pass("Exact transport-owned message ledger without source-context echo");

  const queues = readFileSync(queueLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(queues.length === 2, `expected 2 Codex queue calls, got ${queues.length}`);
  assert(queues.every((args) => args[2] === "session-b"), "queue did not use exact UUID");
  assert(
    queues.some((args) => args[4].startsWith("[From codex agent: codex-a via agent-mesh]")),
    "Codex sender attribution missing",
  );
  assert(
    queues.some((args) => args[4].startsWith("[From claude agent: claude-a via agent-mesh]")),
    "Claude sender attribution missing",
  );
  pass("Codex -> Codex through UUID-based native queue");
  pass("Claude -> Codex through UUID-based native queue");

  const channelContents = claudeB.notifications
    .filter((item) => item.method === "notifications/claude/channel")
    .map((item) => item.params.content);
  assert(
    channelContents.some(
      (content) =>
        content.includes("[From codex agent: codex-a via agent-mesh]") &&
        content.endsWith("codex to claude"),
    ),
    "Codex -> Claude notification missing",
  );
  assert(
    channelContents.some(
      (content) =>
        content.includes("[From claude agent: claude-a via agent-mesh]") &&
        content.endsWith("claude to claude"),
    ),
    "Claude -> Claude notification missing",
  );
  assert(
    claudeA.notifications.every(
      (item) => item.method !== "notifications/claude/channel",
    ),
    "a Claude message leaked to a non-recipient",
  );
  pass("Codex -> Claude through addressed channel notification");
  pass("Claude -> Claude through addressed channel notification");
  pass("Recipient filtering and structural sender attribution");

  // Codex does not forward AGENT_MESH_* to hook commands, so identity must also
  // be recoverable from the launcher's on-disk claim.
  const launchDir = join(project, ".agent-mesh", "launch");
  mkdirSync(launchDir, { recursive: true });
  writeFileSync(
    join(launchDir, "codex-claimed.json"),
    JSON.stringify({
      agent_id: "codex-claimed",
      kind: "codex",
      launcher_pid: process.pid,
      created_at: new Date().toISOString(),
    }),
  );
  const claimed = registerCodexWithoutEnv("session-claimed");
  assert(claimed.status === 0, claimed.stderr || "claim-based registration failed");
  assert(
    sessionRecord("codex-claimed").identity_source === "launch-claim",
    "registration did not fall back to the launcher claim",
  );
  pass("Codex registers from a launch claim with no inherited environment");

  rmSync(launchDir, { recursive: true, force: true });
  const beforeBail = readFileSync(join(project, ".agent-mesh", "agent-mesh.log"), "utf8").length;
  const bailed = registerCodexWithoutEnv("session-unclaimed");
  assert(bailed.status === 0, "a non-mesh Codex session must not fail its SessionStart");
  const bailLog = readFileSync(join(project, ".agent-mesh", "agent-mesh.log"), "utf8")
    .slice(beforeBail)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    bailLog.some(
      (entry) => entry.source === "session-hook" && /no mesh identity/.test(entry.message),
    ),
    "an unidentified SessionStart bailed without leaving a diagnostic",
  );
  pass("Unidentified SessionStart bails quietly but leaves a log entry");

  // A Codex record whose MCP server has exited must not keep absorbing messages.
  const dead = spawnSync(process.execPath, ["-e", ""]);
  writeFileSync(
    join(project, ".agent-mesh", "sessions", "codex-dead.json"),
    JSON.stringify({
      agent_id: "codex-dead",
      kind: "codex",
      session_id: "session-dead",
      cwd: project,
      mcp_pid: dead.pid,
      registered_at: new Date().toISOString(),
    }),
  );
  const afterDeath = JSON.parse((await codexA.call("list_peers", {})).content[0].text);
  assert(
    !afterDeath.peers.some((peer) => peer.agent_id === "codex-dead"),
    "a Codex registration with a dead MCP pid was still listed",
  );
  assert(
    afterDeath.peers.some((peer) => peer.agent_id === "codex-b"),
    "liveness filtering removed a healthy Codex peer",
  );
  pass("Stale Codex registrations are filtered by MCP liveness");

  // An older Codex has no `queue` subcommand; the raw clap usage error alone
  // gives the operator nothing to act on.
  const legacy = new McpProcess("claude-legacy", "claude", {
    AGENT_MESH_CODEX_BIN: fakeOldCodex,
  });
  await legacy.initialize();
  let queueFailure = "";
  try {
    const attempt = await legacy.call("send_peer", {
      recipient: "codex-b",
      message: "should not deliver",
    });
    queueFailure = JSON.stringify(attempt);
  } catch (error) {
    queueFailure = error.message;
  }
  assert(
    queueFailure.includes("0.149.0") && queueFailure.includes("0.144.4"),
    `unsupported codex queue was not diagnosed: ${queueFailure}`,
  );
  pass("Unsupported codex queue reports the required and detected versions");

  // Resuming outside the launcher loses AGENT_MESH_*, so the launcher has to own
  // resume for both agents: Codex takes a subcommand, Claude takes a flag.
  const codexResume = launchArgs("codex", "codex-resume", ["--resume", "--last"], fakeLauncherCodex);
  assert(
    codexResume[0] === "--no-alt-screen" &&
      codexResume[1] === "resume" &&
      codexResume[2] === "--last",
    `codex resume args wrong: ${JSON.stringify(codexResume)}`,
  );
  assert(
    !codexResume.some((argument) => argument.startsWith("Agent-mesh bootstrap:")),
    "a resumed Codex session was given a bootstrap turn",
  );
  const claudeResume = launchArgs("claude", "claude-resume", ["--resume", "abc123"], fakeClaude);
  assert(
    claudeResume.includes("--resume") &&
      claudeResume[claudeResume.indexOf("--resume") + 1] === "abc123" &&
      claudeResume.includes("server:agent-mesh"),
    `claude resume args wrong: ${JSON.stringify(claudeResume)}`,
  );
  pass("Launcher owns resume for both agents and skips the bootstrap turn");

  const orphan = spawnSync(process.execPath, [serverPath], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, AGENT_MESH_CWD: project, AGENT_MESH_ID: "", AGENT_MESH_KIND: "" },
  });
  assert(orphan.status === 1, "server without an identity should exit non-zero");
  assert(
    /AGENT_MESH_ID/.test(orphan.stderr) && /--resume/.test(orphan.stderr),
    `identity failure was not explained: ${orphan.stderr}`,
  );
  pass("Server without a mesh identity explains the failed handshake");

  // `npm --prefix agent-mesh run status` runs with cwd set to the prefix dir,
  // so cwd alone made status silently report an empty mesh.
  const installedDir = join(project, "agent-mesh");
  mkdirSync(installedDir, { recursive: true });
  copyFileSync(statusPath, join(installedDir, "status.js"));
  const fromPrefix = spawnSync(process.execPath, ["status.js"], {
    cwd: installedDir,
    encoding: "utf8",
    env: (() => {
      const clean = { ...process.env };
      delete clean.AGENT_MESH_CWD;
      return clean;
    })(),
  });
  assert(
    fromPrefix.stdout.includes("codex-a") && fromPrefix.stdout.includes("claude-a"),
    `status did not resolve the project root from its own location: ${fromPrefix.stdout}`,
  );
  pass("Status resolves the project root when cwd is the install directory");

  // The MCP server normally stamps liveness before the hook writes the record.
  const stamped = join(project, ".agent-mesh", "sessions", "codex-stamped.json");
  writeFileSync(
    stamped,
    JSON.stringify({
      agent_id: "codex-stamped",
      kind: "codex",
      session_id: "session-old",
      cwd: project,
      mcp_pid: process.pid,
      mcp_started_at: "2026-01-01T00:00:00.000Z",
      registered_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  registerCodex("codex-stamped", "session-new");
  const merged = sessionRecord("codex-stamped");
  assert(
    merged.session_id === "session-new" && merged.mcp_pid === process.pid,
    `hook clobbered a live MCP stamp: ${JSON.stringify(merged)}`,
  );
  pass("SessionStart preserves a live MCP liveness stamp");

  const mistyped = spawnSync(process.execPath, [startPath, "codex", "resume", "--last"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, AGENT_MESH_CODEX_BIN: fakeLauncherCodex },
  });
  assert(mistyped.status === 2, "a mistyped resume was accepted as an agent ID");
  assert(/--resume/.test(mistyped.stderr), "reserved-ID error did not suggest the flag");
  pass("Reserved words are rejected as agent IDs");

  const uninstalled = mkdtempSync(join(tmpdir(), "agent-mesh-bare-"));
  const strayLaunch = spawnSync(process.execPath, [startPath, "claude", "claude-stray"], {
    cwd: uninstalled,
    encoding: "utf8",
    env: { ...process.env, AGENT_MESH_CLAUDE_BIN: fakeClaude },
  });
  rmSync(uninstalled, { recursive: true, force: true });
  assert(strayLaunch.status === 2, "launching outside an installed project was allowed");
  assert(
    /no MCP server configured with that name/.test(strayLaunch.stderr),
    `stray launch did not name the symptom: ${strayLaunch.stderr}`,
  );
  pass("Launching outside an installed project fails with the symptom named");

  // A rollout is the only observable that separates "Codex accepted the item"
  // from "the recipient actually read it", and it is what peek_peer reads.
  const rolloutRoot = join(project, "codex-sessions", "2026", "09", "03");
  mkdirSync(rolloutRoot, { recursive: true });
  const writeRollout = (sessionId, records) =>
    writeFileSync(
      join(rolloutRoot, `rollout-2026-09-03T00-00-00-${sessionId}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  const at = (offsetMs) => new Date(Date.now() - offsetMs).toISOString();

  writeRollout("sess-consumed", [
    { timestamp: at(5000), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
    {
      timestamp: at(4000),
      type: "response_item",
      payload: { type: "message", role: "user", content: "peer message body that is long enough to match" },
    },
    {
      timestamp: at(3000),
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t1", duration_ms: 2000 },
    },
  ]);
  writeRollout("sess-busy", [
    {
      timestamp: at(90000),
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "CommandExecution", command: "python3 long_job.py" } },
    },
    { timestamp: at(60000), type: "event_msg", payload: { type: "task_started", turn_id: "t9" } },
  ]);
  writeRollout("sess-errored", [
    { timestamp: at(9000), type: "event_msg", payload: { type: "task_started", turn_id: "t2" } },
    {
      timestamp: at(8000),
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t2", error: { message: "Your workspace is out of credits." } },
    },
  ]);
  process.env.AGENT_MESH_CODEX_SESSIONS = join(project, "codex-sessions");

  assert(
    searchNeedle("peer message body that is long enough to match") !== null,
    "searchNeedle found nothing to match on ordinary prose",
  );

  const consumed = await confirmConsumption({
    sessionId: "sess-consumed",
    message: "peer message body that is long enough to match",
    budgetMs: 500,
  });
  assert(consumed.state === "consumed", `consumed message reported as ${consumed.state}`);

  const pending = await confirmConsumption({
    sessionId: "sess-busy",
    message: "a different message body that was never consumed at all",
    budgetMs: 400,
    pollMs: 100,
  });
  assert(pending.state === "pending", `unconsumed message reported as ${pending.state}`);
  const warning = describeDelivery(pending, "codex-b");
  assert(/NOT YET DELIVERED/.test(warning), "pending delivery was not flagged as undelivered");
  assert(/cannot cancel/.test(warning), "pending delivery did not say the message cannot be cancelled");
  assert(/[Dd]o not re-send/.test(warning), "pending delivery did not warn against re-sending");
  assert(
    /Delivered/.test(describeDelivery(consumed, "codex-b")),
    "consumed delivery was not reported as delivered",
  );

  const missing = await confirmConsumption({
    sessionId: "sess-does-not-exist",
    message: "any message body long enough to be matchable here",
    budgetMs: 200,
  });
  assert(missing.state === "unknown", "an unobservable session did not degrade to unknown");
  pass("Codex delivery is confirmed from the recipient rollout, not the queue acknowledgement");

  const busy = peekSession("sess-busy");
  assert(busy.state === "working", `a mid-turn session reported ${busy.state}`);
  assert(busy.since_ms >= 50000, `mid-turn elapsed time looks wrong: ${busy.since_ms}`);
  assert(
    busy.recent.some((entry) => /python3 long_job.py/.test(entry.detail)),
    "peek did not surface the peer's recent command",
  );
  const idle = peekSession("sess-consumed");
  assert(idle.state === "idle", `a finished session reported ${idle.state}`);
  const errored = peekSession("sess-errored");
  assert(
    /out of credits/.test(errored.last_error || ""),
    "peek did not surface the peer's last turn error",
  );
  assert(
    peekSession("sess-does-not-exist").state === "unknown",
    "peek did not degrade to unknown for an unobservable session",
  );
  delete process.env.AGENT_MESH_CODEX_SESSIONS;
  pass("peek_peer reports whether a peer is working, idle, or failing");

  clearTimeout(timeout);
  cleanup();
} catch (error) {
  clearTimeout(timeout);
  cleanup();
  process.stderr.write(`FAIL  ${error.message}\n`);
  process.exit(1);
}
