#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

// `npm --prefix agent-mesh run ...` runs with cwd set to the prefix directory,
// not the project root, so cwd alone silently points at the wrong state dir.
// This script always lives at <project>/agent-mesh/, which does not move.
function resolveProjectRoot() {
  if (process.env.AGENT_MESH_CWD) return resolve(process.env.AGENT_MESH_CWD);
  const beside = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(join(beside, ".agent-mesh"))) return beside;
  return resolve(process.cwd());
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A live Codex launch owns a dedicated Unix listener. Its temporary MCP
// clients can exit while that listener still accepts deliveries.
export async function registrationHealth(record) {
  const pid = record.kind === "claude" ? record.pid : record.mcp_pid;
  if (processAlive(pid)) return { label: "live", note: `pid ${pid}` };
  const path = record.app_server_socket;
  if (record.kind === "codex" && typeof path === "string" && isAbsolute(path)) {
    const reachable = await new Promise(resolve => {
      const socket = createConnection({ path });
      const finish = (value) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
    return reachable
      ? { label: "live", note: "live app-server accepts connections" }
      : { label: "STALE", note: "live app-server unavailable" };
  }
  if (Number.isInteger(pid)) return { label: "STALE", note: `pid ${pid} is gone` };
  return { label: "unconfirmed", note: "no live process confirmed" };
}

async function printStatus() {
  const projectRoot = resolveProjectRoot();
  const sessionDir = join(projectRoot, ".agent-mesh", "sessions");

  if (!existsSync(sessionDir)) {
    process.stdout.write("No mesh agents are registered.\n");
    process.exit(1);
  }

  let valid = 0;
  let degraded = 0;
  for (const filename of readdirSync(sessionDir).sort()) {
    if (!filename.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(sessionDir, filename), "utf8"));
      const state = await registrationHealth(record);
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await printStatus();
}
