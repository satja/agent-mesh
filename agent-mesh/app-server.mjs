import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

export class RpcError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
  }
}

// Connect directly to the recipient's Unix WebSocket listener. This connection
// never answers approvals: the human's subscribed terminal owns those.
export class AppServerClient {
  constructor({ socket, timeoutMs = 10000, deadline = Infinity }) {
    this.timeoutMs = timeoutMs;
    this.deadline = deadline;
    this.pending = new Map();
    this.nextId = 1;
    if (typeof socket !== "string" || !socket.startsWith("/") || socket.includes(":")) {
      throw new Error("Invalid local Codex socket path");
    }
    this.ws = new WebSocket(`ws+unix://${socket}:/`, {
      handshakeTimeout: timeoutMs, perMessageDeflate: false,
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    // Avoid an unhandled rejection if startup fails before initialize is called.
    this.opened.catch(() => {});
    this.ws.on("message", (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.method) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error));
      else pending.resolve(message.result);
    });
    this.ws.on("error", (error) => this.fail(error));
    this.ws.on("close", () => this.fail(new Error("Codex control connection closed")));
  }

  fail(error) {
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const timeoutMs = Math.min(this.timeoutMs, this.deadline - Date.now());
    if (timeoutMs <= 0) return Promise.reject(new Error("Codex delivery deadline exceeded"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async initialize() {
    await this.opened;
    await this.request("initialize", {
      clientInfo: { name: "agent_mesh", title: "Agent Mesh", version: "1.0.0" },
    });
    this.ws.send(JSON.stringify({ method: "initialized" }));
  }

  close() {
    this.fail(new Error("Codex control connection closed"));
    this.ws.terminate();
  }
}

const here = dirname(fileURLToPath(import.meta.url));

function pythonExecutable() {
  if (process.env.AGENT_MESH_PYTHON_BIN) return process.env.AGENT_MESH_PYTHON_BIN;
  const local = process.platform === "win32"
    ? join(here, ".venv", "Scripts", "python.exe")
    : join(here, ".venv", "bin", "python");
  if (!existsSync(local)) {
    throw new Error(`Codex Python SDK environment is missing at ${local}; rerun the agent-mesh installer.`);
  }
  return local;
}

export function sendToAppServer({ socket, threadId, text, python = pythonExecutable() }) {
  const script = join(here, "external-message.py");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd: here,
      env: { ...process.env, AGENT_MESH_NODE_BIN: process.execPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(
        "Delivery outcome unknown after ExternalMessage timed out" +
        (stderr.trim() ? `: ${stderr.trim()}` : "") +
        ". Do not re-send or queue a duplicate; wait for the recipient to respond.",
      )));
    }, 20000);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-10000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-10000); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => {
      if (code !== 0) {
        const detail = stderr.trim() || `Python helper exited with status ${code}`;
        if (/failed to submit turn input/i.test(detail) || /Nothing was sent/i.test(detail)) {
          reject(new Error(detail));
        } else {
          reject(new Error(
            `Delivery outcome unknown after ExternalMessage: ${detail}. ` +
            "Do not re-send or queue a duplicate; wait for the recipient to respond.",
          ));
        }
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (typeof result.turnId !== "string" || !result.turnId.trim()) {
          throw new Error("invalid result shape");
        }
        resolve(result);
      } catch (error) {
        reject(new Error(
          `Delivery outcome unknown because the ExternalMessage helper returned invalid output: ${error.message}. ` +
          "Do not re-send or queue a duplicate; wait for the recipient to respond.",
        ));
      }
    }));
    child.stdin.end(JSON.stringify({ socket, threadId, content: text }));
  });
}
