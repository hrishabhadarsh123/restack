/**
 * MCP server tests over the in-memory transport: handshake metadata, tool
 * list, scan tool output (agent summary + `_restack` JSON block) and graceful
 * status handling. Plan/convert need a provider key — their no-key contract
 * is pinned by test/mcp-smoke.mjs in CI (env keys stripped).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRestackMcpServer } from "../src/mcp.js";
import { VERSION } from "../src/version.js";

async function connect(): Promise<Client> {
  const server = createRestackMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: { content?: { type: string; text?: string }[] }): string {
  const block = (res.content ?? []).find((c) => c.type === "text");
  expect(block, "tool result should carry a text block").toBeDefined();
  return block!.text ?? "";
}

/** Extract the machine-readable `_restack` JSON block appended by the tools. */
function restackPayload(text: string): Record<string, unknown> {
  const marker = "_restack: ";
  const idx = text.indexOf(marker);
  expect(idx, "expected a _restack JSON block").toBeGreaterThanOrEqual(0);
  return JSON.parse(text.slice(idx + marker.length)) as Record<string, unknown>;
}

describe("restack MCP server", () => {
  it("announces itself as restack with the package version", async () => {
    const client = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe("restack");
    expect(info?.version).toBe(VERSION);
    await client.close();
  });

  it("exposes the four pipeline tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "restack_convert",
      "restack_plan",
      "restack_scan",
      "restack_status",
    ]);
    await client.close();
  });

  it("restack_scan returns a summary plus machine-readable _restack block", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "restack_scan", arguments: { projectRoot: "test/fixtures/php-app" } });
    const text = textOf(res as { content?: { type: string; text?: string }[] });
    expect(text).toContain("Stack: php-jquery");

    const payload = restackPayload(text) as { stack: string; fileCount: number; totalTokens: number };
    expect(payload.stack).toBe("php-jquery");
    expect(payload.fileCount).toBeGreaterThan(0);
    expect(payload.totalTokens).toBeGreaterThan(0);
    // Sensitive file contents are never surfaced — only the excluded paths.
    expect(text).not.toContain("SECRET");
    await client.close();
  });

  it("restack_scan detects the django fixture", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "restack_scan", arguments: { projectRoot: "test/fixtures/django-app" } });
    const text = textOf(res as { content?: { type: string; text?: string }[] });
    expect(restackPayload(text)).toMatchObject({ stack: "django" });
    await client.close();
  });

  it("restack_status is graceful when nothing has been converted", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "restack_status",
      arguments: { outDir: "test/.mcp-nothing-here" },
    });
    const text = textOf(res as { content?: { type: string; text?: string }[] });
    expect(text).toContain("No restack state found");
    await client.close();
  });
});
