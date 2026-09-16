import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AppServerClient, deliverLive, RpcError } from "./app-server.mjs";
import { serverOptions } from "./live-launch.mjs";

const snapshot = (state, id = "turn-a") => ({ thread: {
  status: { type: state }, turns: state === "active" ? [{ id, status: "inProgress" }] : [],
} });

function scripted(steps) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      // Serve the preliminary metadata read without consuming a scripted history read.
      if (method === "thread/read" && !params.includeTurns && steps[0]?.[1]?.thread?.status?.type === "active") return steps[0][1];
      calls.push({ method, params });
      const step = steps.shift();
      assert.ok(step, `Unexpected ${method}`);
      assert.equal(method, step[0]);
      if (step[1] instanceof Error) throw step[1];
      return step[1];
    },
  };
}

test("busy delivery steers the exact active turn without changing policy", async () => {
  const client = scripted([["thread/read", snapshot("active")], ["turn/steer", { turnId: "turn-a" }]]);
  assert.deepEqual(await deliverLive(client, "thread-a", "hello"), { method: "turn/steer", turnId: "turn-a" });
  assert.deepEqual(client.calls[1].params, {
    threadId: "thread-a", expectedTurnId: "turn-a", input: [{ type: "text", text: "hello" }],
  });
});

test("idle delivery starts a turn without overriding recipient configuration", async () => {
  const client = scripted([["thread/read", snapshot("idle")], ["turn/start", { turn: { id: "turn-b" } }]]);
  await deliverLive(client, "thread-a", "hello");
  assert.deepEqual(client.calls[1].params, { threadId: "thread-a", input: [{ type: "text", text: "hello" }] });
});

test("busy-to-idle race refreshes only after explicit rejection", async () => {
  const client = scripted([
    ["thread/read", snapshot("active")],
    ["turn/steer", new RpcError({ code: -32600, message: "no active turn" })],
    ["thread/read", snapshot("idle")], ["turn/start", { turn: { id: "turn-b" } }],
  ]);
  assert.equal((await deliverLive(client, "thread-a", "hello")).method, "turn/start");
});

test("changed active turn is refreshed instead of reusing a stale ID", async () => {
  const client = scripted([
    ["thread/read", snapshot("active")],
    ["turn/steer", new RpcError({ code: -32600, message: "expected active turn id `turn-a` but found `turn-b`" })],
    ["thread/read", snapshot("active", "turn-b")], ["turn/steer", { turnId: "turn-b" }],
  ]);
  await deliverLive(client, "thread-a", "hello");
  assert.equal(client.calls[3].params.expectedTurnId, "turn-b");
});

test("turn ending between metadata and history reads is delivered with start", async () => {
  const client = { async request(method, params) {
    if (method === "thread/read") return snapshot(params.includeTurns ? "idle" : "active");
    assert.equal(method, "turn/start");
    return { turn: { id: "turn-b" } };
  } };
  assert.equal((await deliverLive(client, "thread-a", "hello")).method, "turn/start");
});

test("unknown delivery outcomes and non-race rejections never resend", async () => {
  for (const state of ["active", "idle"]) {
    for (const error of [new Error("connection lost"), new RpcError({ code: -32600, message: "permission denied" })]) {
      const client = scripted([["thread/read", snapshot(state)], [state === "active" ? "turn/steer" : "turn/start", error]]);
      await assert.rejects(deliverLive(client, "thread-a", "hello"), error instanceof RpcError ? /permission denied/ : /outcome unknown.*Do not re-send/);
      assert.equal(client.calls.length, 2);
    }
  }
});

test("unloaded threads are never resumed or started behind the terminal", async () => {
  const client = scripted([["thread/read", snapshot("notLoaded")]]);
  await assert.rejects(deliverLive(client, "thread-a", "hello"), /Nothing was sent/);
  assert.equal(client.calls.length, 1);
});

test("unsupported active history falls back to atomic start-or-steer without queueing", async () => {
  const calls = [];
  const client = { async request(method, params) {
    calls.push({ method, params });
    if (method === "thread/read" && !params.includeTurns) {
      return { thread: { status: { type: "active" }, turns: [] } };
    }
    if (method === "thread/read") throw new RpcError({ code: -32601, message: "list_turns is not supported yet" });
    assert.equal(method, "turn/start");
    return { turn: { id: "turn-a" } };
  } };
  assert.deepEqual(await deliverLive(client, "thread-a", "hello"), { method: "turn/start", turnId: "turn-a" });
  assert.equal(calls.length, 3);
});

test("repeated turn races stop after a bounded number of attempts", async () => {
  const steps = Array.from({ length: 3 }, () => [
    ["thread/read", snapshot("active")], ["turn/steer", new RpcError({ code: -32600, message: "no active turn" })],
  ]).flat();
  const client = scripted(steps);
  await assert.rejects(deliverLive(client, "thread-a", "hello"), /not accepted/);
  assert.equal(client.calls.length, 6);
});

test("live launcher forwards backend configuration and rejects unsupported launch modes", () => {
  assert.deepEqual(serverOptions(["--no-alt-screen", "-c", "model=\"test\"", "--enable=hooks", "--strict-config", "--model", "test"]),
    ["-c", "model=\"test\"", "--enable=hooks", "--strict-config"]);
  for (const flag of ["--remote", "--worktree", "--profile", "-C"]) assert.throws(() => serverOptions([flag]), /not supported/);
});

test("Unix WebSocket transport correlates replies, ignores approvals, and times out without retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-ws-test-"));
  const socket = join(directory, "control.sock");
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const seen = [];
  ws.on("connection", (peer) => peer.on("message", (data) => {
    const message = JSON.parse(data.toString()); seen.push(message);
    if (message.method === "initialize") peer.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "thread/read") {
      peer.send(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} }));
      peer.send(JSON.stringify({ method: "turn/completed", params: {} }));
      peer.send(JSON.stringify({ id: message.id, result: snapshot("idle") }));
    }
    // Intentionally lose the turn/start response after accepting the request.
  }));
  await new Promise((resolve) => http.listen(socket, resolve));
  const client = new AppServerClient({ socket, timeoutMs: 100 });
  try {
    await client.initialize();
    await assert.rejects(deliverLive(client, "thread-a", "hello"), /outcome unknown/);
    assert.deepEqual(seen.map((x) => x.method), ["initialize", "initialized", "thread/read", "turn/start"]);
  } finally {
    client.close();
    for (const peer of ws.clients) peer.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live launcher shares identity and socket with terminal and hook, then cleans up", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-launch-test-"));
  const fake = join(directory, "codex.mjs");
  const log = join(directory, "launch.jsonl");
  const here = fileURLToPath(new URL(".", import.meta.url));
  mkdirSync(join(directory, ".codex"));
  writeFileSync(join(directory, ".codex", "config.toml"), "[mcp_servers.agent-mesh]\n");
  writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { WebSocketServer } from ${JSON.stringify(import.meta.resolve("ws"))};
const args=process.argv.slice(2);
if(args.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
appendFileSync(process.env.TEST_LOG, JSON.stringify({args,id:process.env.AGENT_MESH_ID,kind:process.env.AGENT_MESH_KIND,socket:process.env.AGENT_MESH_CODEX_SOCKET,pid:process.pid})+'\\n');
if(args.includes('app-server')) {
 const http=createServer();const ws=new WebSocketServer({server:http});
 ws.on('connection',peer=>peer.on('message',data=>{const m=JSON.parse(data);if(m.id)peer.send(JSON.stringify({id:m.id,result:{}}));}));
 http.listen(args[args.indexOf('--listen')+1].slice('unix://'.length));
} else {
 for(const omitted of [{},{AGENT_MESH_CODEX_SOCKET:''},{AGENT_MESH_CODEX_SOCKET:'',AGENT_MESH_ID:'',AGENT_MESH_KIND:''}]) {
  const r=spawnSync(process.execPath,[${JSON.stringify(join(here, "session-hook.js"))}],{input:JSON.stringify({hook_event_name:'SessionStart',session_id:'live-session',cwd:process.cwd()}),encoding:'utf8',env:{...process.env,...omitted}});
  if(r.status!==0)throw new Error(r.stderr);
 }
}
`, { mode: 0o755 });
  const child = spawn(process.execPath, [join(here, "start"), "codex", "live-a", "--mesh-live", "--resume", "live-session"], {
    cwd: directory, env: { ...process.env, AGENT_MESH_CWD: directory, AGENT_MESH_CODEX_BIN: fake, TEST_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (x) => { output += x; });
  child.stderr.on("data", (x) => { output += x; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, output);
    const [backend, terminal] = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(backend.id, "live-a");
    assert.equal(terminal.id, "live-a");
    assert.equal(backend.socket, terminal.socket);
    assert.deepEqual(terminal.args, ["--remote", `unix://${backend.socket}`, "--no-alt-screen", "resume", "live-session"]);
    const record = JSON.parse(readFileSync(join(directory, ".agent-mesh/sessions/live-a.json")));
    assert.equal(record.app_server_socket, backend.socket);
    assert.equal(record.session_id, "live-session");
    assert.equal(existsSync(backend.socket), false);
    assert.equal(existsSync(join(directory, ".agent-mesh/launch/live-a.json")), false);
    assert.throws(() => process.kill(backend.pid, 0), { code: "ESRCH" });
    const legacy = spawnSync(process.execPath, [join(here, "session-hook.js")], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "live-session", cwd: directory }),
      encoding: "utf8",
      env: { ...process.env, AGENT_MESH_ID: "live-a", AGENT_MESH_KIND: "codex", AGENT_MESH_CODEX_SOCKET: "" },
    });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(JSON.parse(readFileSync(join(directory, ".agent-mesh/sessions/live-a.json"))).app_server_socket, undefined);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude send_peer selects live Codex delivery and records the message once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-live-mcp-"));
  const socket = join(directory, "control.sock");
  const sessions = join(directory, ".agent-mesh/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "codex-live.json"), JSON.stringify({
    agent_id: "codex-live", kind: "codex", session_id: "thread-a", cwd: directory,
    mcp_pid: process.pid, app_server_socket: socket,
  }));
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const requests = [];
  ws.on("connection", (peer) => peer.on("message", (data) => {
    const m = JSON.parse(data); requests.push(m);
    if (!m.id) return;
    const result = m.method === "thread/read" ? snapshot("idle") : m.method === "turn/start" ? { turn: { id: "turn-new" } } : {};
    peer.send(JSON.stringify({ id: m.id, result }));
  }));
  await new Promise((resolve) => http.listen(socket, resolve));
  const client = new Client({ name: "mesh-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("server.js", import.meta.url))], cwd: directory,
    env: { ...process.env, AGENT_MESH_CWD: directory, AGENT_MESH_ID: "claude-source", AGENT_MESH_KIND: "claude", AGENT_MESH_CODEX_BIN: "/no-queue-fallback" },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "send_peer", arguments: { recipient: "codex-live", message: "live hello" } });
    assert.match(result.content[0].text, /Accepted by Codex via turn\/start/);
    assert.equal(requests.filter((r) => r.method === "turn/start").length, 1);
    assert.equal(requests.at(-1).params.input[0].text, "[From claude agent: claude-source via agent-mesh]\n\nlive hello");
    const ledger = readFileSync(join(directory, ".agent-mesh/messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].transport, "codex-app-server");
    assert.equal(ledger[0].message, "live hello");
  } finally {
    await client.close();
    for (const peer of ws.clients) peer.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
