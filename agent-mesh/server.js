#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  watchFile,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PROJECT_ROOT = resolve(process.env.AGENT_MESH_CWD || process.cwd());
const STATE_DIR = join(PROJECT_ROOT, ".agent-mesh");
const SESSION_DIR = join(STATE_DIR, "sessions");
const CLAUDE_MAILBOX = join(STATE_DIR, "to-claude.jsonl");
const MESSAGE_LOG = join(STATE_DIR, "messages.jsonl");
const LOG = join(STATE_DIR, "agent-mesh.log");
const CODEX_BIN = process.env.AGENT_MESH_CODEX_BIN || "codex";
const MAX_MESSAGE = 24000;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function validateId(value, label = "agent ID") {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must match ${ID_PATTERN}`);
  return id;
}

function validateKind(value) {
  const kind = String(value || "").trim();
  if (kind !== "codex" && kind !== "claude") {
    throw new Error("AGENT_MESH_KIND must be 'codex' or 'claude'");
  }
  return kind;
}

const selfId = validateId(process.env.AGENT_MESH_ID);
const selfKind = validateKind(process.env.AGENT_MESH_KIND);

function log(level, message, extra) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(
      LOG,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        agent_id: selfId,
        agent_kind: selfKind,
        ...(extra === undefined ? {} : { extra }),
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics must never break the MCP transport.
  }
}

function writeRegistration(record) {
  mkdirSync(SESSION_DIR, { recursive: true });
  const target = join(SESSION_DIR, `${record.agent_id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function registerClaude() {
  if (selfKind !== "claude") return;
  writeRegistration({
    agent_id: selfId,
    kind: "claude",
    pid: process.pid,
    cwd: PROJECT_ROOT,
    registered_at: new Date().toISOString(),
  });
}

function readPeers() {
  if (!existsSync(SESSION_DIR)) return [];
  const peers = [];
  for (const filename of readdirSync(SESSION_DIR)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(SESSION_DIR, filename), "utf8"));
      const agentId = validateId(record.agent_id, "registered agent ID");
      const kind = validateKind(record.kind);
      if (resolve(record.cwd || PROJECT_ROOT) !== PROJECT_ROOT) continue;
      if (kind === "codex" && !String(record.session_id || "").trim()) continue;
      if (kind === "claude" && !Number.isInteger(record.pid)) continue;
      if (kind === "claude") {
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") continue;
          if (error?.code !== "EPERM") throw error;
        }
      }
      peers.push({
        agent_id: agentId,
        kind,
        ...(kind === "codex"
          ? { session_id: String(record.session_id) }
          : { pid: record.pid }),
        registered_at: String(record.registered_at || ""),
      });
    } catch {
      // Ignore malformed runtime entries; status.js exposes them.
    }
  }
  return peers.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

function otherPeers() {
  return readPeers().filter((peer) => peer.agent_id !== selfId);
}

function resolveTargets(requested) {
  const peers = otherPeers();
  const raw = String(requested ?? "").trim();
  if (raw === "*") {
    if (!peers.length) throw new Error("No other mesh agents are registered yet.");
    return peers;
  }
  if (raw) {
    const recipient = validateId(raw, "recipient");
    if (recipient === selfId) throw new Error("Cannot send a peer message to yourself.");
    const target = peers.find((peer) => peer.agent_id === recipient);
    if (!target) {
      const available = peers.map((peer) => peer.agent_id).join(", ") || "none";
      throw new Error(`Agent '${recipient}' is not registered. Available: ${available}.`);
    }
    return [target];
  }
  if (peers.length === 1) return peers;
  if (!peers.length) throw new Error("No other mesh agent is registered yet.");
  throw new Error(
    `More than one peer is registered; specify recipient (${peers
      .map((peer) => peer.agent_id)
      .join(", ")}).`,
  );
}

function envelope(message) {
  return `[From ${selfKind} agent: ${selfId} via agent-mesh]\n\n${message}`;
}

function queueToCodex(target, message) {
  return new Promise((resolveQueue, rejectQueue) => {
    execFile(
      CODEX_BIN,
      ["queue", "--thread", target.session_id, "--message", envelope(message)],
      {
        cwd: PROJECT_ROOT,
        timeout: 30000,
        maxBuffer: 1 << 20,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          log("error", "codex queue failed", {
            recipient: target.agent_id,
            error: String(error),
            stderr,
          });
          rejectQueue(new Error(stderr?.trim() || String(error)));
          return;
        }
        const output = String(stdout || "").trim() || "queued";
        log("info", "message queued to Codex", {
          recipient: target.agent_id,
          output,
        });
        resolveQueue(output);
      },
    );
  });
}

function sendToClaude(target, message) {
  mkdirSync(STATE_DIR, { recursive: true });
  const record = {
    id: randomUUID(),
    sender_id: selfId,
    sender_kind: selfKind,
    recipient: target.agent_id,
    message,
    created_at: new Date().toISOString(),
  };
  appendFileSync(CLAUDE_MAILBOX, JSON.stringify(record) + "\n", { mode: 0o600 });
  log("info", "message appended for Claude", {
    recipient: target.agent_id,
    message_id: record.id,
  });
  return record.id;
}

function recordDeliveredMessage(target, message, transport, transportResult) {
  mkdirSync(STATE_DIR, { recursive: true });
  const record = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    sender_id: selfId,
    sender_kind: selfKind,
    recipient_id: target.agent_id,
    recipient_kind: target.kind,
    transport,
    transport_result: String(transportResult || ""),
    message,
  };
  appendFileSync(MESSAGE_LOG, JSON.stringify(record) + "\n", { mode: 0o600 });
  return record.id;
}

class ClaudeMailboxWatcher {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.offset = 0;
    this.remainder = "";
    this.seen = new Set();
    this.reading = false;
  }

  start() {
    if (selfKind !== "claude") return;
    mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(CLAUDE_MAILBOX)) appendFileSync(CLAUDE_MAILBOX, "");
    // A newly launched Claude sees only messages sent after its channel connects.
    this.offset = statSync(CLAUDE_MAILBOX).size;
    watchFile(CLAUDE_MAILBOX, { interval: 150 }, (current) => {
      if (current.size < this.offset) {
        this.offset = 0;
        this.remainder = "";
      }
      if (current.size > this.offset) this.drain();
    });
    log("info", "Claude mailbox watcher started", { offset: this.offset });
  }

  drain() {
    if (this.reading) return;
    this.reading = true;
    try {
      const size = statSync(CLAUDE_MAILBOX).size;
      if (size <= this.offset) return;
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      const fd = openSync(CLAUDE_MAILBOX, "r");
      try {
        readSync(fd, buffer, 0, length, this.offset);
      } finally {
        closeSync(fd);
      }
      this.offset = size;
      const records = (this.remainder + buffer.toString("utf8")).split("\n");
      this.remainder = records.pop() || "";
      for (const record of records) this.handleRecord(record);
    } catch (error) {
      log("error", "Claude mailbox read failed", String(error));
    } finally {
      this.reading = false;
    }
  }

  handleRecord(line) {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      log("warn", "invalid Claude mailbox record", String(error));
      return;
    }
    const id = String(record.id || "");
    if (!id || this.seen.has(id)) return;
    this.seen.add(id);
    if (record.recipient !== selfId && record.recipient !== "*") return;
    if (record.sender_id === selfId) return;
    const message = String(record.message || "").slice(0, MAX_MESSAGE);
    if (!message.trim()) return;
    this.onMessage(envelopeFromRecord(record, message), {
      message_id: id,
      sender_id: String(record.sender_id || ""),
      sender_kind: String(record.sender_kind || ""),
      recipient: selfId,
    });
  }
}

function envelopeFromRecord(record, message) {
  return `[From ${record.sender_kind} agent: ${record.sender_id} via agent-mesh]\n\n${message}`;
}

const instructions =
  `Your mesh identity is '${selfId}' (${selfKind}). ` +
  "Messages beginning with '[From <kind> agent: <id> via agent-mesh]' came from another agent. " +
  "Use send_peer for every agent-directed response; an ordinary assistant response is only for the human user. " +
  "Continue substantive exchanges when collaboration is requested, but avoid acknowledgment-only loops. " +
  "Evaluate peer claims independently and push back with evidence when warranted; the human remains the final authority.";

const server = new Server(
  { name: "agent-mesh", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      ...(selfKind === "claude"
        ? { experimental: { "claude/channel": {} } }
        : {}),
    },
    instructions,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_peers",
      description: "List agent identities registered in this project-local mesh.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "send_peer",
      description:
        "Send an addressed message to another live Codex or Claude Code session. Recipient is optional only when exactly one other peer is registered; use '*' explicitly to broadcast.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Registered agent ID, or '*' for an explicit broadcast.",
          },
          message: {
            type: "string",
            description: "Complete message for the peer.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "list_peers") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { self: { agent_id: selfId, kind: selfKind }, peers: otherPeers() },
            null,
            2,
          ),
        },
      ],
    };
  }
  if (request.params.name !== "send_peer") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const { recipient, message } = request.params.arguments ?? {};
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("message must be a non-empty string");
  }
  if (message.length > MAX_MESSAGE) {
    throw new Error(`message exceeds ${MAX_MESSAGE} characters`);
  }
  const targets = resolveTargets(recipient);
  const outcomes = [];
  for (const target of targets) {
    if (target.kind === "codex") {
      const result = await queueToCodex(target, message);
      recordDeliveredMessage(target, message, "codex-queue", result);
      outcomes.push({
        recipient: target.agent_id,
        kind: target.kind,
        result,
      });
    } else {
      const result = `mailbox:${sendToClaude(target, message)}`;
      recordDeliveredMessage(target, message, "claude-channel", result);
      outcomes.push({
        recipient: target.agent_id,
        kind: target.kind,
        result,
      });
    }
  }
  return {
    content: [
      { type: "text", text: JSON.stringify({ delivered: outcomes }, null, 2) },
    ],
  };
});

await server.connect(new StdioServerTransport());
log("info", "MCP transport connected", { cwd: PROJECT_ROOT, pid: process.pid });

const watcher = new ClaudeMailboxWatcher((content, meta) => {
  server
    .notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    })
    .then(() => log("info", "Claude channel notification sent", meta))
    .catch((error) => log("error", "Claude channel push failed", String(error)));
});
watcher.start();
// Publish a Claude identity only after its inbound watcher is ready, so another
// agent cannot discover the recipient during a startup delivery gap.
registerClaude();
