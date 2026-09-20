#!/usr/bin/env node
/**
 * MCP smoke test (CI-friendly): spawns the built CLI in MCP mode and speaks
 * newline-delimited JSON-RPC over stdio directly. Provider keys are stripped
 * from the child environment, so this needs no network access. Verifies:
 *   1. initialize handshake → serverInfo.name === "restack"
 *   2. tools/list → all four pipeline tools
 *   3. tools/call restack_scan → summary text + parseable _restack JSON
 *   4. tools/call restack_plan without any key → actionable error, no crash
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const fixture = path.join(root, "test", "fixtures", "php-app");

const KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];
const env = { ...process.env };
for (const k of KEY_VARS) delete env[k];

const child = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });

let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d;
});

/** id -> resolve callback for in-flight JSON-RPC requests. */
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(id, method, params, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for response to ${method} (id ${id})`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`JSON-RPC error for ${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function textOf(result) {
  const block = (result.content ?? []).find((c) => c.type === "text");
  if (!block) throw new Error("no text content in tool result: " + JSON.stringify(result).slice(0, 200));
  return block.text;
}

function restackPayload(text) {
  const marker = "_restack: ";
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error("missing _restack JSON block in: " + text.slice(0, 200));
  return JSON.parse(text.slice(idx + marker.length));
}

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "restack-smoke", version: "0.0.0" },
  });
  if (init.serverInfo?.name !== "restack") {
    throw new Error("bad serverInfo: " + JSON.stringify(init.serverInfo));
  }
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listed = await request(2, "tools/list", {});
  const names = listed.tools.map((t) => t.name).sort();
  const expected = ["restack_convert", "restack_plan", "restack_scan", "restack_status"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error("unexpected tool list: " + names.join(", "));
  }

  const scan = await request(3, "tools/call", {
    name: "restack_scan",
    arguments: { projectRoot: fixture },
  });
  const scanText = textOf(scan);
  if (!scanText.includes("Stack: php-jquery")) {
    throw new Error("scan text missing stack summary: " + scanText.slice(0, 200));
  }
  const payload = restackPayload(scanText);
  if (payload.stack !== "php-jquery") throw new Error("scan payload stack: " + payload.stack);
  if (!(payload.fileCount > 0)) throw new Error("scan payload has no files");

  const plan = await request(4, "tools/call", {
    name: "restack_plan",
    arguments: { projectRoot: fixture },
  });
  const planText = textOf(plan);
  if (!planText.includes("No model provider key")) {
    throw new Error("plan without keys should explain the missing provider key, got: " + planText.slice(0, 300));
  }

  console.log("MCP smoke OK: handshake, tools/list, restack_scan (+_restack JSON), no-key plan error");
  process.exitCode = 0;
} catch (err) {
  console.error("MCP smoke FAILED:", err.message);
  if (stderr.trim()) {
    console.error("server stderr (tail):\n" + stderr.trim().split("\n").slice(-20).join("\n"));
  }
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
}
