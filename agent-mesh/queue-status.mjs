// Delivery confirmation and peer observation for the Codex transport.
//
// `codex queue` returns "Queued message <id> for thread <id>." the moment the
// item is written to Codex's queue database. That string says nothing about
// whether the recipient ever saw it. A session that is mid-turn, and a thread
// whose session is gone entirely, both accept the item and leave it sitting, so
// a sender that trusts the acceptance string believes it delivered a message
// that is in front of nobody. Codex exposes no way to cancel a queued item, so
// the sender's only defence is knowing which of the two happened.
//
// A Codex session writes a queued item into its rollout jsonl at the moment it
// actually consumes it, and records its turn lifecycle there too. The rollout
// is therefore the observable for both "was this delivered" and "what is that
// agent doing". It is plain JSONL, which matters: Node 20 has no node:sqlite
// and the queue database cannot be read without adding a native dependency.

import { existsSync, openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Read per call, not once at import, so the suite can point at a synthetic
// rollout tree after this module is loaded.
function sessionsRoot() {
  return process.env.AGENT_MESH_CODEX_SESSIONS || join(homedir(), ".codex", "sessions");
}
// Enough of the tail to hold a turn's events without reading a multi-megabyte
// rollout on every call.
const TAIL_BYTES = 512 * 1024;

export function rolloutPathFor(sessionId) {
  const root = sessionsRoot();
  if (!sessionId || !existsSync(root)) return null;
  const matches = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes(sessionId)) matches.push(full);
    }
  };
  walk(root);
  return matches.length ? matches.sort().pop() : null;
}

function readTail(path, bytes = TAIL_BYTES) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    // A tail read almost always starts mid-line; drop the partial first line.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  }
}

function parseRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A rollout can be mid-write; skip unparseable lines.
    }
  }
  return records;
}

// ---------------------------------------------------------------- delivery

// The rollout stores the message JSON-escaped, so match on a slice that survives
// escaping unchanged: the longest run of plain characters in the message.
export function searchNeedle(message) {
  const runs = String(message).match(/[A-Za-z0-9 ,.:;()\-_/]{24,}/g);
  if (!runs || !runs.length) return null;
  return runs.sort((a, b) => b.length - a.length)[0].slice(0, 120).trim();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watch a recipient's rollout briefly to see whether the item Codex just
 * accepted is actually consumed.
 *
 *   consumed  the recipient took it; genuinely in front of that agent now
 *   pending   accepted but not consumed inside the budget, so the recipient is
 *             mid-turn or its session is gone; it surfaces only at that
 *             session's next turn boundary, and cannot be cancelled
 *   unknown   no rollout found, or the message has no matchable slice
 */
export async function confirmConsumption({ sessionId, message, budgetMs = 2000, pollMs = 250 }) {
  const rollout = rolloutPathFor(sessionId);
  const needle = searchNeedle(message);
  if (!rollout || !needle) {
    return {
      state: "unknown",
      rollout,
      reason: rollout ? "message has no matchable text" : "no rollout file for that session",
    };
  }
  const startedAt = Date.now();
  for (;;) {
    if (readTail(rollout).includes(needle)) {
      return { state: "consumed", rollout, waited_ms: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= budgetMs) {
      return { state: "pending", rollout, waited_ms: Date.now() - startedAt };
    }
    await wait(pollMs);
  }
}

export function describeDelivery(status, recipientId) {
  if (status.state === "consumed") {
    return `Delivered: ${recipientId} consumed it and can see it now.`;
  }
  if (status.state === "pending") {
    return (
      `QUEUED, NOT YET DELIVERED: ${recipientId} did not consume this within ` +
      `${status.waited_ms} ms, so it is mid-turn or its session is gone. The message ` +
      `surfaces only at that session's next turn boundary, which can be a long time, and ` +
      `Codex cannot cancel a queued message. Do not re-send it. Use peek_peer to see ` +
      `whether ${recipientId} is working, and expect no prompt reply.`
    );
  }
  return `Delivery unconfirmed (${status.reason}); Codex accepted the message into the queue.`;
}

// ------------------------------------------------------------- live writer

// Codex takes a per-thread writer lock when a session successfully opens a
// thread, and leaves the lock file behind afterwards. So the file's ABSENCE is
// conclusive: no session ever opened that thread, and anything queued to it can
// never be read. Its presence is weaker and only means some session opened it
// at some point, which is why the registry's own mcp_pid liveness check still
// does the work of spotting a session that has since exited.
export function threadNeverOpened(sessionId) {
  if (!sessionId) return true;
  const lock = join(
    process.env.AGENT_MESH_CODEX_LOCKS || join(homedir(), ".codex", "thread-writer-locks"),
    `${sessionId}.lock`,
  );
  return !existsSync(lock);
}

// ------------------------------------------------------------------- peek

function describeItem(item) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type || "");
  if (type === "CommandExecution") {
    const command = String(item.command || "").replace(/\s+/g, " ").trim();
    return command ? `ran: ${command.slice(0, 160)}` : "ran a command";
  }
  if (type === "UserMessage") return "received a message";
  if (type === "AgentMessage") return "replied";
  if (type === "Reasoning") return "thinking";
  if (type === "FileChange") return "edited files";
  if (type === "McpToolCall") {
    return `called ${item.server || "mcp"}.${item.tool || "tool"}`;
  }
  return type ? `${type}` : null;
}

/**
 * Summarise what a peer session is doing, from its rollout.
 * Returns { state: "working" | "idle" | "unknown", ... }.
 */
export function peekSession(sessionId, { activity = 5 } = {}) {
  const rollout = rolloutPathFor(sessionId);
  if (!rollout) return { state: "unknown", reason: "no rollout file for that session" };

  const records = parseRecords(readTail(rollout));
  if (!records.length) return { state: "unknown", reason: "no readable rollout records", rollout };

  let started = null;
  let completed = null;
  let lastError = null;
  const recent = [];

  for (const record of records) {
    const payload = record.payload || {};
    const at = record.timestamp || null;
    if (payload.type === "task_started") started = { turn_id: payload.turn_id, at };
    if (payload.type === "task_complete") {
      completed = { turn_id: payload.turn_id, at, duration_ms: payload.duration_ms };
      if (payload.error?.message) lastError = String(payload.error.message);
    }
    if (payload.type === "turn_aborted") completed = { turn_id: payload.turn_id, at, aborted: true };
    if (payload.type === "item_completed") {
      const detail = describeItem(payload.item);
      if (detail) recent.push({ at, detail });
    }
  }

  const working = Boolean(started) && (!completed || completed.turn_id !== started.turn_id);
  const referenceAt = working ? started?.at : completed?.at || records[records.length - 1]?.timestamp;
  const sinceMs = referenceAt ? Date.now() - Date.parse(referenceAt) : null;

  return {
    state: working ? "working" : "idle",
    turn_id: working ? started.turn_id : completed?.turn_id || null,
    since_ms: Number.isFinite(sinceMs) ? sinceMs : null,
    last_error: lastError,
    recent: recent.slice(-activity),
    rollout,
  };
}

function humanMs(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export function describePeek(peek, agentId) {
  if (peek.state === "unknown") return `${agentId}: cannot observe (${peek.reason}).`;
  const lines = [];
  lines.push(
    peek.state === "working"
      ? `${agentId} is WORKING (current turn started ${humanMs(peek.since_ms)} ago). ` +
          "A message sent now waits until this turn ends."
      : `${agentId} is IDLE (last turn ended ${humanMs(peek.since_ms)} ago). ` +
          "A message sent now should be picked up promptly.",
  );
  if (peek.last_error) lines.push(`Last turn reported an error: ${peek.last_error}`);
  if (peek.recent.length) {
    lines.push("Recent activity:");
    for (const entry of peek.recent) lines.push(`  ${entry.at || "?"}  ${entry.detail}`);
  }
  return lines.join("\n");
}
