#!/usr/bin/env node

import { createInterface } from "node:readline";
import WebSocket from "ws";

const socket = process.argv[2];
if (typeof socket !== "string" || !socket.startsWith("/") || socket.includes(":")) {
  process.stderr.write("Invalid local Codex socket path\n");
  process.exit(2);
}

const ws = new WebSocket(`ws+unix://${socket}:/`, {
  handshakeTimeout: 10000,
  perMessageDeflate: false,
});
const pending = [];
let opened = false;
let ending = false;

ws.on("open", () => {
  opened = true;
  for (const line of pending.splice(0)) ws.send(line);
});
ws.on("message", (data) => process.stdout.write(`${data.toString()}\n`));
ws.on("error", (error) => {
  process.stderr.write(`Codex WebSocket bridge failed: ${error.message}\n`);
  process.exitCode = 1;
});
ws.on("close", () => process.exit(process.exitCode || 0));

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  if (opened) ws.send(line);
  else pending.push(line);
});
input.on("close", () => {
  ending = true;
  if (opened) ws.close();
  else ws.terminate();
});

process.on("SIGTERM", () => {
  if (!ending) ws.terminate();
  process.exit(0);
});
