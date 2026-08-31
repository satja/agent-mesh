#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(process.env.AGENT_MESH_CWD || process.cwd());
const sessionDir = join(projectRoot, ".agent-mesh", "sessions");

if (!existsSync(sessionDir)) {
  process.stdout.write("No mesh agents are registered.\n");
  process.exit(1);
}

let valid = 0;
for (const filename of readdirSync(sessionDir).sort()) {
  if (!filename.endsWith(".json")) continue;
  try {
    const record = JSON.parse(readFileSync(join(sessionDir, filename), "utf8"));
    process.stdout.write(
      `${record.agent_id}\t${record.kind}\t${record.session_id || `pid:${record.pid}`}\t${record.registered_at || "unknown time"}\n`,
    );
    valid += 1;
  } catch (error) {
    process.stdout.write(`INVALID\t${filename}\t${error.message}\n`);
  }
}

if (!valid) {
  process.stdout.write("No valid mesh agents are registered.\n");
  process.exit(1);
}
