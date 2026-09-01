#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// A launch claim must survive repeated SessionStart events (startup, resume,
// clear, compact) but never outlive its launcher process.
const CLAIM_TTL_MS = 12 * 60 * 60 * 1000;

let stateDir = join(resolve(process.cwd()), ".agent-mesh");

function log(level, message, extra) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(
      join(stateDir, "agent-mesh.log"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        source: "session-hook",
        pid: process.pid,
        ...(extra === undefined ? {} : { extra }),
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics must never break a Codex session start.
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Codex normally does pass AGENT_MESH_* through to hook commands, but the hook
// still gets no identity when it runs before the user has trusted it, or when
// the session was started outside the launcher. The launcher therefore also
// records a claim on disk so registration does not depend on the environment.
function readClaims() {
  const directory = join(stateDir, "launch");
  if (!existsSync(directory)) return [];
  const claims = [];
  for (const filename of readdirSync(directory)) {
    if (!filename.endsWith(".json")) continue;
    const path = join(directory, filename);
    try {
      const claim = JSON.parse(readFileSync(path, "utf8"));
      const agentId = String(claim.agent_id || "");
      if (claim.kind !== "codex" || !ID_PATTERN.test(agentId)) continue;
      if (!Number.isInteger(claim.launcher_pid)) continue;
      const age = Date.now() - Date.parse(claim.created_at || "");
      if (!Number.isFinite(age) || age > CLAIM_TTL_MS || !processAlive(claim.launcher_pid)) {
        rmSync(path, { force: true });
        continue;
      }
      claims.push({ agent_id: agentId, launcher_pid: claim.launcher_pid });
    } catch {
      // A malformed claim must not block an otherwise healthy launch.
    }
  }
  return claims;
}

function ancestorPids() {
  const chain = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 64 && Number.isInteger(pid) && pid > 1; depth += 1) {
    chain.push(pid);
    let parent = null;
    try {
      const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s*(\d+)$/m);
      if (match) parent = Number(match[1]);
    } catch {
      break;
    }
    if (!Number.isInteger(parent) || parent === pid) break;
    pid = parent;
  }
  return chain;
}

function resolveIdentity() {
  const envKind = String(process.env.AGENT_MESH_KIND || "").trim();
  const envId = String(process.env.AGENT_MESH_ID || "").trim();
  if (envKind || envId) {
    if (envKind !== "codex") return null;
    if (!ID_PATTERN.test(envId)) throw new Error(`invalid AGENT_MESH_ID: ${envId}`);
    return { agentId: envId, source: "env" };
  }

  const claims = readClaims();
  if (!claims.length) return null;
  if (claims.length === 1) return { agentId: claims[0].agent_id, source: "launch-claim" };

  // Several Codex agents are starting at once, so fall back to process ancestry
  // to find the claim written by this session's own launcher.
  const ancestors = new Set(ancestorPids());
  const matches = claims.filter((claim) => ancestors.has(claim.launcher_pid));
  if (matches.length === 1) {
    return { agentId: matches[0].agent_id, source: "launch-claim-ancestry" };
  }
  log("warn", "ambiguous Codex launch claims; identity not resolved", {
    candidates: claims.map((claim) => claim.agent_id),
  });
  return null;
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = JSON.parse(input);
  if (event.hook_event_name !== "SessionStart") process.exit(0);
  const projectRoot = resolve(event.cwd || process.cwd());
  stateDir = join(projectRoot, ".agent-mesh");

  const identity = resolveIdentity();
  // An ordinary Codex session may use this project without joining the mesh.
  if (!identity) {
    log("info", "SessionStart carried no mesh identity; nothing registered", {
      matcher: String(event.source || ""),
      env_id_present: Boolean(String(process.env.AGENT_MESH_ID || "").trim()),
    });
    process.exit(0);
  }

  const sessionId = String(event.session_id || "").trim();
  if (!sessionId) throw new Error("SessionStart omitted session_id");

  const sessionDir = join(stateDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const target = join(sessionDir, `${identity.agentId}.json`);
  // The MCP server usually connects before this hook runs and stamps the record
  // with its pid. Overwriting blindly would erase the only liveness signal a
  // Codex registration has, so carry a still-live stamp forward.
  let carried = {};
  try {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (
      existing.agent_id === identity.agentId &&
      existing.kind === "codex" &&
      Number.isInteger(existing.mcp_pid) &&
      processAlive(existing.mcp_pid)
    ) {
      carried = {
        mcp_pid: existing.mcp_pid,
        mcp_started_at: existing.mcp_started_at,
      };
    }
  } catch {
    // No usable prior record; register from scratch.
  }
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify(
      {
        agent_id: identity.agentId,
        kind: "codex",
        session_id: sessionId,
        cwd: projectRoot,
        identity_source: identity.source,
        registered_at: new Date().toISOString(),
        ...carried,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  renameSync(temporary, target);
  log("info", "Codex identity registered", {
    agent_id: identity.agentId,
    session_id: sessionId,
    identity_source: identity.source,
  });
} catch (error) {
  log("error", "session hook failed", String(error?.message || error));
  process.stderr.write(`agent-mesh session hook failed: ${error.message}\n`);
  process.exitCode = 1;
}
