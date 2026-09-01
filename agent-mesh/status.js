#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(process.env.AGENT_MESH_CWD || process.cwd());
const sessionDir = join(projectRoot, ".agent-mesh", "sessions");

if (!existsSync(sessionDir)) {
  process.stdout.write("No mesh agents are registered.\n");
  process.exit(1);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A Codex record is only reachable once its MCP server has stamped a live pid;
// until then the session registered but never connected.
function health(record) {
  const pid = record.kind === "claude" ? record.pid : record.mcp_pid;
  if (!Number.isInteger(pid)) {
    return record.kind === "codex"
      ? { label: "unconfirmed", note: "MCP server never connected" }
      : { label: "unconfirmed", note: "no pid recorded" };
  }
  return processAlive(pid)
    ? { label: "live", note: `pid ${pid}` }
    : { label: "STALE", note: `pid ${pid} is gone` };
}

let valid = 0;
let degraded = 0;
for (const filename of readdirSync(sessionDir).sort()) {
  if (!filename.endsWith(".json")) continue;
  try {
    const record = JSON.parse(readFileSync(join(sessionDir, filename), "utf8"));
    const state = health(record);
    if (state.label !== "live") degraded += 1;
    process.stdout.write(
      `${record.agent_id}\t${record.kind}\t${record.session_id || `pid:${record.pid}`}\t` +
        `${record.registered_at || "unknown time"}\t${state.label}\t${state.note}\n`,
    );
    valid += 1;
  } catch (error) {
    process.stdout.write(`INVALID\t${filename}\t${error.message}\n`);
    degraded += 1;
  }
}

if (!valid) {
  process.stdout.write("No valid mesh agents are registered.\n");
  process.exit(1);
}

if (degraded) {
  process.stdout.write(
    `\n${degraded} registration(s) are not confirmed live. A Codex agent that is\n` +
      "missing entirely never ran its SessionStart hook; relaunch it through\n" +
      "./agent-mesh/start and check agent-mesh.log for 'session-hook' entries.\n",
  );
  process.exit(2);
}
