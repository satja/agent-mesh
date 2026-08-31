#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = mkdtempSync(join(tmpdir(), "agent-mesh-test-"));
const hook = join(here, "session-hook.js");
const serverPath = join(here, "server.js");
const startPath = join(here, "start");
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

class McpProcess {
  constructor(agentId, kind) {
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
  assert(names.includes("list_peers") && names.includes("send_peer"), "missing tools");
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

  clearTimeout(timeout);
  cleanup();
} catch (error) {
  clearTimeout(timeout);
  cleanup();
  process.stderr.write(`FAIL  ${error.message}\n`);
  process.exit(1);
}
