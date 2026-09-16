import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerClient } from "./app-server.mjs";

export function serverOptions(args) {
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i].split("=")[0];
    if (["--remote", "--remote-auth-token-env", "--profile", "-p", "--worktree", "--cd", "-C"].includes(flag)) {
      throw new Error(`${flag} is not supported with live delivery yet. Launch from the project directory using its default profile, or select --mesh-queue.`);
    }
    if (["-c", "--config", "--enable", "--disable"].includes(flag)) {
      result.push(args[i]);
      if (!args[i].includes("=")) {
        if (!args[i + 1]) throw new Error(`${flag} requires a value`);
        result.push(args[++i]);
      }
    } else if (flag === "--strict-config") result.push(args[i]);
  }
  return result;
}

function signalChild(child, signal, group) {
  if (!child?.pid) return;
  try {
    if (group) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stop(child, group = false) {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (group) signalChild(child, "SIGKILL", true);
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalChild(child, "SIGTERM", group);
  const timer = setTimeout(() => signalChild(child, "SIGKILL", group), 2000);
  await exited;
  clearTimeout(timer);
  if (group) signalChild(child, "SIGKILL", true);
}

// A dedicated backend preserves AGENT_MESH_ID for hooks and MCP subprocesses.
export async function launchLive({ command, args, cwd, env, onReady }) {
  const options = serverOptions(args);
  if (process.platform !== "linux") {
    throw new Error("Live delivery is currently supported on Linux only. Use --mesh-queue for the temporary fallback.");
  }
  const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10000, cwd, env });
  const parts = String(version.stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!parts || (Number(parts[1]) === 0 && Number(parts[2]) < 154)) {
    throw new Error("Live delivery requires Codex CLI 0.154.0 or newer (tested with 0.154.0). Update Codex or use --mesh-queue (requires 0.149.0+).");
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-mesh-live-"));
  const socket = join(directory, "control.sock");
  const logDir = join(cwd, ".agent-mesh");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${env.AGENT_MESH_ID}-app-server.log`);
  const log = openSync(logPath, "a", 0o600);
  const childEnv = { ...env, AGENT_MESH_CODEX_SOCKET: socket };
  let backend;
  let terminal;
  let stopped = false;
  let backendError;
  const terminate = () => {
    stopped = true;
    terminal?.kill("SIGTERM");
    signalChild(backend, "SIGTERM", true);
  };
  // Ctrl-C belongs to the terminal UI. Do not turn its task cancellation into
  // shutdown of the mesh backend, which has its own process group.
  const onInterrupt = () => {};
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", terminate);
  try {
    backend = spawn(command, [...options, "app-server", "--listen", `unix://${socket}`], {
      cwd, env: childEnv, stdio: ["ignore", log, log], detached: true,
    });
    backend.on("error", (error) => { backendError = error; });
    backend.on("exit", () => {
      backendError ||= new Error(`Codex app-server exited. See ${logPath}`);
      terminal?.kill("SIGTERM");
    });
    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !stopped && !backendError) {
      const client = new AppServerClient({ socket, timeoutMs: 1000 });
      try { await client.initialize(); ready = true; break; }
      catch { await delay(100); }
      finally { client.close(); }
    }
    if (!ready || stopped || backendError) {
      throw backendError || new Error(`Codex app-server did not become ready. See ${logPath}`);
    }
    onReady(socket);
    process.stdout.write("Live mesh delivery enabled (steer while busy, start while idle).\n");
    terminal = spawn(command, ["--remote", `unix://${socket}`, ...args], {
      cwd, env: childEnv, stdio: "inherit",
    });
    return await new Promise((resolve, reject) => {
      terminal.once("error", reject);
      terminal.once("exit", (code) => resolve(backendError ? 1 : (code ?? 1)));
    });
  } finally {
    await stop(terminal);
    await stop(backend, true);
    closeSync(log);
    rmSync(directory, { recursive: true, force: true });
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", terminate);
  }
}
