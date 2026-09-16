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

export async function deliverLive(client, threadId, text) {
  const input = [{ type: "text", text }];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let { thread } = await client.request("thread/read", { threadId, includeTurns: false });
    // A fresh 0.154 thread can reject history reads before its first turn.
    if (thread.status?.type === "active") {
      try {
        ({ thread } = await client.request("thread/read", { threadId, includeTurns: true }));
      } catch (error) {
        // Some 0.154 paginated threads cannot hydrate history. turn/start
        // atomically steers an active turn too (verified against 0.154).
        if (!(error instanceof RpcError) || error.code !== -32601) throw error;
      }
    }
    const state = thread.status?.type;
    if (state !== "active" && state !== "idle") {
      throw new Error(`Recipient thread is ${state || "unknown"}; relaunch its mesh terminal. Nothing was sent.`);
    }
    const active = thread.turns?.findLast((turn) => turn.status === "inProgress");
    const method = state === "active" && active ? "turn/steer" : "turn/start";
    try {
      const result = await client.request(method, {
        threadId, input,
        ...(method === "turn/steer" ? { expectedTurnId: active.id } : {}),
      });
      return { method, turnId: result.turnId || result.turn?.id };
    } catch (error) {
      // Only an explicit precondition rejection proves that retrying is safe.
      if (method === "turn/steer" && error instanceof RpcError &&
          /no active turn|expected active turn id .* but found |turn.*mismatch/i.test(error.message)) continue;
      if (error instanceof RpcError) throw error;
      throw new Error(`Delivery outcome unknown after ${method}: ${error.message}. Do not re-send or queue a duplicate; inspect the recipient first.`);
    }
  }
  throw new Error("Recipient turn changed repeatedly. Message was not accepted; try again later.");
}

export async function sendToAppServer({ socket, threadId, text }) {
  // Return before the mesh MCP tool's 30-second timeout, including race retries.
  const client = new AppServerClient({ socket, deadline: Date.now() + 20000 });
  try {
    await client.initialize();
    return await deliverLive(client, threadId, text);
  } finally {
    client.close();
  }
}
