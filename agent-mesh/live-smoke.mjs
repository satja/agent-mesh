// Optional integration test: real Codex, isolated CODEX_HOME, local mock model.
// Requires Codex 0.154.0+ and permission to bind local sockets. No paid API calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerClient, sendToAppServer } from "./app-server.mjs";

const directory = mkdtempSync("/tmp/mesh-live-smoke-");
const socket = `${directory}/control.sock`;
const env = { ...process.env, CODEX_HOME: directory };
const requests = [];
const events = [];
let serverError;
const api = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed.tools));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    emit(res, {
      type: "response.created",
      response: { id: `resp_${requests.length}`, object: "response", status: "in_progress", output: [] },
    });
    requests.push({ res, parsed });
  } catch (error) {
    serverError = error;
    res.destroy();
  }
});
await new Promise((resolve, reject) => {
  api.once("error", reject);
  api.listen(0, "127.0.0.1", resolve);
});
writeFileSync(`${directory}/config.toml`, `model="gpt-5.4"
model_provider="mock"
[features]
enable_request_compression=false
[model_providers.mock]
name="mock"
base_url="http://127.0.0.1:${api.address().port}/v1"
wire_api="responses"
`);
const backend = spawn(process.env.AGENT_MESH_CODEX_BIN || "codex", ["app-server", "--listen", `unix://${socket}`], {
  cwd: directory, env, detached: true, stdio: ["ignore", "ignore", "pipe"],
});
let logs = "";
backend.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-4000); });
backend.on("error", (error) => { serverError = error; });
let terminal;
let race;

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (serverError) throw serverError;
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timeout waiting for ${label}: ${logs}`);
}

function emit(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function finish(res, output) {
  for (let i = 0; i < output.length; i += 1) {
    emit(res, { type: "response.output_item.added", output_index: i, item: output[i] });
    emit(res, { type: "response.output_item.done", output_index: i, item: output[i] });
  }
  emit(res, {
    type: "response.completed",
    response: {
      id: "resp_done", object: "response", status: "completed", output,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  res.end();
}

try {
  for (let i = 0; i < 100; i += 1) {
    if (serverError) throw serverError;
    terminal = new AppServerClient({ socket, timeoutMs: 1000 });
    try { await terminal.initialize(); break; }
    catch { terminal.close(); terminal = null; await delay(100); }
  }
  if (!terminal) throw new Error(`App-server did not start: ${logs}`);
  terminal.timeoutMs = 10000;
  terminal.ws.on("message", (data) => events.push(JSON.parse(data)));
  const { thread } = await terminal.request("thread/start", {
    cwd: directory, model: "gpt-5.4", approvalPolicy: "on-request", sandbox: "read-only",
  });
  const idle = await sendToAppServer({ socket, threadId: thread.id, text: "Smoke test input" });
  assert.equal(idle.method, "turn/start");
  await waitFor(() => requests.length === 1, "model request");
  const busy = await sendToAppServer({ socket, threadId: thread.id, text: "Additional smoke input" });
  assert.equal(busy.turnId, idle.turnId);
  assert.ok(["turn/steer", "turn/start"].includes(busy.method));

  // Direct turn/start while active verifies the idle-to-busy race.
  race = new AppServerClient({ socket });
  await race.initialize();
  await assert.rejects(race.request("turn/steer", {
    threadId: thread.id, expectedTurnId: "stale-id", input: [{ type: "text", text: "rejected input" }],
  }), /expected active turn id/);
  const raced = await race.request("turn/start", {
    threadId: thread.id, input: [{ type: "text", text: "racing input" }],
  });
  assert.equal(raced.turn.id, idle.turnId);
  race.close();

  // All sending clients have disconnected. The receiving client must still
  // receive the approval and completion. Decline the command; never execute it.
  finish(requests[0].res, [{
    type: "function_call", id: "fc_smoke", call_id: "call_smoke", name: "exec_command",
    arguments: JSON.stringify({
      cmd: "printf smoke", sandbox_permissions: "require_escalated",
      justification: "Local approval routing smoke test",
    }),
  }]);
  await waitFor(() => events.some((e) => e.method?.includes("requestApproval")) || requests.length > 1, "approval");
  const approval = events.find((e) => e.method?.includes("requestApproval"));
  assert.ok(approval, "Receiving client must receive approval after sender disconnects");
  terminal.ws.send(JSON.stringify({ id: approval.id, result: { decision: "decline" } }));
  await waitFor(() => requests.length > 1, "followup");
  finish(requests.at(-1).res, [{
    type: "message", id: "msg_done", role: "assistant",
    content: [{ type: "output_text", text: "Smoke test complete" }],
  }]);
  await waitFor(() => events.some((e) => e.method === "turn/completed"), "turn completion");
  const completed = events.find((e) => e.method === "turn/completed");
  assert.equal(completed.params.turn.id, idle.turnId);
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(events.filter((e) => e.method === "turn/started").length, 1);
  const followup = JSON.stringify(requests.at(-1).parsed.input);
  assert.ok(followup.includes("Additional smoke input"));
  assert.ok(followup.includes("racing input"));
  assert.ok(!followup.includes("rejected input"));
  console.log("PASS Real Codex: idle start, busy delivery, stale-turn rejection, idle-to-busy race, approval routing, and completion after sender disconnect");
} finally {
  race?.close();
  terminal?.close();
  for (const request of requests) request.res.destroy();
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  if (backend.pid) {
    const exited = backend.exitCode !== null || backend.signalCode !== null
      ? Promise.resolve() : new Promise((resolve) => backend.once("exit", resolve));
    try { process.kill(-backend.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    await exited;
  }
  rmSync(directory, { recursive: true, force: true });
}
