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
import { AppServerClient, sendToAppServer } from "./app-server.mjs";
import { serverOptions } from "./live-launch.mjs";

test("live delivery delegates one exact message to the Python SDK helper", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-sdk-helper-"));
  const helper = join(directory, "python");
  const log = join(directory, "request.json");
  writeFileSync(helper, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let body='';
process.stdin.on('data',chunk=>body+=chunk);
process.stdin.on('end',()=>{writeFileSync(process.env.TEST_LOG,body);console.log(JSON.stringify({delivery:'joined',turnId:'turn-a'}));});
`, { mode: 0o755 });
  try {
    const previous = process.env.TEST_LOG;
    process.env.TEST_LOG = log;
    try {
      assert.deepEqual(await sendToAppServer({
        socket: "/tmp/codex.sock", threadId: "thread-a", text: "hello", python: helper,
      }), { delivery: "joined", turnId: "turn-a" });
    } finally {
      if (previous === undefined) delete process.env.TEST_LOG;
      else process.env.TEST_LOG = previous;
    }
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), {
      socket: "/tmp/codex.sock", threadId: "thread-a", content: "hello",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("helper failures are never retried or silently queued", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-sdk-failure-"));
  const helper = join(directory, "python");
  writeFileSync(helper, "#!/bin/sh\necho 'connection lost' >&2\nexit 1\n", { mode: 0o755 });
  try {
    await assert.rejects(sendToAppServer({
      socket: "/tmp/codex.sock", threadId: "thread-a", text: "hello", python: helper,
    }), /outcome unknown.*Do not re-send/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const snapshot = (state) => ({ thread: { status: { type: state } } });

test("live launcher forwards backend configuration and rejects unsupported launch modes", () => {
  assert.deepEqual(serverOptions(["--no-alt-screen", "-c", "model=\"test\"", "--enable=hooks", "--strict-config", "--model", "test"]),
    ["-c", "model=\"test\"", "--enable=hooks", "--strict-config"]);
  for (const flag of ["--remote", "--worktree", "--profile", "-C"]) assert.throws(() => serverOptions([flag]), /not supported/);
});

test("Unix WebSocket transport correlates replies and ignores approval requests", async () => {
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
  }));
  await new Promise((resolve) => http.listen(socket, resolve));
  const client = new AppServerClient({ socket, timeoutMs: 100 });
  try {
    await client.initialize();
    assert.deepEqual(await client.request("thread/read", { threadId: "thread-a", includeTurns: false }), snapshot("idle"));
    assert.deepEqual(seen.map((x) => x.method), ["initialize", "initialized", "thread/read"]);
  } finally {
    client.close();
    for (const peer of ws.clients) peer.terminate();
    await new Promise((resolve) => ws.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const resuming of [false, true]) {
test(`default live launcher ${resuming ? "resumes" : "bootstraps"}, shares identity, and cleans up`, async () => {
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
  const child = spawn(process.execPath, [join(here, "start"), "codex", "live-a", ...(resuming ? ["--resume", "live-session"] : [])], {
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
    assert.deepEqual(terminal.args.slice(0, 3), ["--remote", `unix://${backend.socket}`, "--no-alt-screen"]);
    if (resuming) assert.deepEqual(terminal.args.slice(3), ["resume", "live-session"]);
    else assert.match(terminal.args[3], /^Agent-mesh bootstrap:/);
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
}

test("transport flags reject conflicts and Claude usage before launching", () => {
  const launcher = fileURLToPath(new URL("start", import.meta.url));
  for (const args of [
    ["codex", "test-agent", "--mesh-live", "--mesh-queue"],
    ["claude", "test-agent", "--mesh-queue"],
    ["claude", "test-agent", "--mesh-live"],
  ]) {
    const result = spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not both|only supported for Codex/);
  }
});

test("Claude send_peer selects live Codex delivery and records the message once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mesh-live-mcp-"));
  const socket = join(directory, "control.sock");
  const helper = join(directory, "python");
  const helperLog = join(directory, "external-message.json");
  const sessions = join(directory, ".agent-mesh/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "codex-live.json"), JSON.stringify({
    agent_id: "codex-live", kind: "codex", session_id: "thread-a", cwd: directory,
    mcp_pid: process.pid, app_server_socket: socket,
  }));
  writeFileSync(helper, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let body='';process.stdin.on('data',chunk=>body+=chunk);
process.stdin.on('end',()=>{writeFileSync(process.env.TEST_LOG,body);console.log(JSON.stringify({delivery:'started',turnId:'turn-new'}));});
`, { mode: 0o755 });
  const client = new Client({ name: "mesh-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("server.js", import.meta.url))], cwd: directory,
    env: {
      ...process.env,
      AGENT_MESH_CWD: directory,
      AGENT_MESH_ID: "claude-source",
      AGENT_MESH_KIND: "claude",
      AGENT_MESH_CODEX_BIN: "/no-queue-fallback",
      AGENT_MESH_PYTHON_BIN: helper,
      TEST_LOG: helperLog,
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "send_peer", arguments: { recipient: "codex-live", message: "live hello" } });
    assert.match(result.content[0].text, /Python SDK ExternalMessage API/);
    assert.deepEqual(JSON.parse(readFileSync(helperLog, "utf8")), {
      socket,
      threadId: "thread-a",
      content: "[From claude agent: claude-source via agent-mesh]\n\nlive hello",
    });
    const ledger = readFileSync(join(directory, ".agent-mesh/messages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].transport, "codex-app-server");
    assert.equal(ledger[0].message, "live hello");
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
