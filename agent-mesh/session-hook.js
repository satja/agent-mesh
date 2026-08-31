#!/usr/bin/env node

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const event = JSON.parse(input);
  if (event.hook_event_name !== "SessionStart") process.exit(0);

  const kind = String(process.env.AGENT_MESH_KIND || "").trim();
  const agentId = String(process.env.AGENT_MESH_ID || "").trim();
  // An ordinary Codex session may use this project without joining the mesh.
  if (!kind && !agentId) process.exit(0);
  if (kind !== "codex") process.exit(0);
  if (!ID_PATTERN.test(agentId)) throw new Error(`invalid AGENT_MESH_ID: ${agentId}`);

  const sessionId = String(event.session_id || "").trim();
  if (!sessionId) throw new Error("SessionStart omitted session_id");
  const projectRoot = resolve(event.cwd || process.cwd());
  const sessionDir = join(projectRoot, ".agent-mesh", "sessions");
  mkdirSync(sessionDir, { recursive: true });

  const target = join(sessionDir, `${agentId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify(
      {
        agent_id: agentId,
        kind: "codex",
        session_id: sessionId,
        cwd: projectRoot,
        registered_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  renameSync(temporary, target);
} catch (error) {
  process.stderr.write(`agent-mesh session hook failed: ${error.message}\n`);
  process.exitCode = 1;
}
