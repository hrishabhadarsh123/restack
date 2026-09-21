/**
 * MCP server tests over the in-memory transport: handshake metadata, tool
 * list, scan tool output (agent summary + `_restack` JSON block), graceful
 * status handling, and the guidance layer — prompts (migration walkthrough,
 * resume) and resources (stack notes, CLI reference, run state). Plan/convert
 * need a provider key — their no-key contract is pinned by test/mcp-smoke.mjs
 * in CI (env keys stripped).
 */
import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRestackMcpServer } from "../src/mcp.js";
import { saveState } from "../src/state.js";
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

describe("restack MCP prompts & resources", () => {
  const stateDir = "test/.mcp-state-fixture";

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Pull the single user-message text out of a prompt result. */
  function promptText(res: { messages: { role: string; content: { type: string; text?: string } }[] }): string {
    expect(res.messages.length, "prompt should carry one message").toBeGreaterThan(0);
    const msg = res.messages[0];
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    return msg.content.text ?? "";
  }

  it("lists both guidance prompts", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["migration_walkthrough", "resume_migration"]);
    await client.close();
  });

  it("migration_walkthrough without args points at restack_scan", async () => {
    const client = await connect();
    const res = await client.getPrompt({ name: "migration_walkthrough", arguments: {} });
    const text = promptText(res as never);
    expect(text).toContain("restack migration walkthrough");
    expect(text).toContain("restack_scan");
    expect(text).toContain("maxCostUsd");
    // Not stack-tailored yet → tells the agent to detect first.
    expect(text).toContain("restack_scan");
    expect(text).not.toContain("Detected stack:");
    await client.close();
  });

  it("migration_walkthrough tailors to a known stack", async () => {
    const client = await connect();
    const res = await client.getPrompt({ name: "migration_walkthrough", arguments: { stack: "django" } });
    const text = promptText(res as never);
    expect(text).toContain("Detected stack: django → target: fastapi");
    expect(text).toContain("SQLAlchemy");
    await client.close();
  });

  it("migration_walkthrough rejects unknown stacks", async () => {
    const client = await connect();
    const res = await client.getPrompt({ name: "migration_walkthrough", arguments: { stack: "perl-cgi" } });
    expect(promptText(res as never)).toContain("not a known restack stack");
    await client.close();
  });

  it("resume_migration without state guides to a fresh start", async () => {
    const client = await connect();
    const res = await client.getPrompt({ name: "resume_migration", arguments: { outDir: "test/.mcp-nothing-here" } });
    expect(promptText(res as never)).toContain("No restack run state found");
    await client.close();
  });

  it("resume_migration reads saved state and offers resume steps", async () => {
    await saveState(stateDir, {
      version: 1 as const,
      projectRoot: "test/fixtures/php-app",
      target: "nextjs",
      model: "claude-sonnet-4-5",
      planHash: "test-hash",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      usd: 0.42,
      completedSources: {
        "includes/db.php": { status: "converted", outputs: ["lib/db.ts"], attempts: 1 },
        "about.php": { status: "failed", outputs: [], attempts: 2, error: "verify failed" },
      },
    });
    const client = await connect();
    const res = await client.getPrompt({ name: "resume_migration", arguments: { outDir: stateDir } });
    const text = promptText(res as never);
    expect(text).toContain("test/fixtures/php-app → nextjs");
    expect(text).toContain("Spend so far");
    expect(text).toContain("converted: 1");
    expect(text).toContain("failed: 1");
    expect(text).toContain("Failed sources: about.php");
    expect(text).toContain("resume: true");
    await client.close();
  });

  it("exposes static resources and the stacks template", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toContain("restack://docs/cli.md");
    expect(uris).toContain("restack://state.json");
    // Template list expansion surfaces the per-stack notes.
    expect(uris.filter((u) => u.startsWith("restack://stacks/")).length).toBe(3);

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["restack://stacks/{stack}"]);
    await client.close();
  });

  it("reads stack notes and rejects unknown stacks", async () => {
    const client = await connect();
    const res = await client.readResource({ uri: "restack://stacks/django" });
    expect(res.contents.length).toBe(1);
    const block = res.contents[0] as { text?: string };
    expect(block.text).toContain("Legacy stack: django");
    expect(block.text).toContain("FastAPI");

    const bad = await client.readResource({ uri: "restack://stacks/nope" });
    expect((bad.contents[0] as { text?: string }).text).toContain("Unknown stack");
    await client.close();
  });

  it("reads the CLI reference resource", async () => {
    const client = await connect();
    const res = await client.readResource({ uri: "restack://docs/cli.md" });
    const block = res.contents[0] as { text?: string };
    expect(block.text).toContain("restack convert");
    expect(block.text).toContain("restack mcp");
    await client.close();
  });

  it("state resource is graceful before any run", async () => {
    const client = await connect();
    const res = await client.readResource({ uri: "restack://state.json" });
    expect((res.contents[0] as { text?: string }).text).toContain("No restack state found");
    await client.close();
  });
});
