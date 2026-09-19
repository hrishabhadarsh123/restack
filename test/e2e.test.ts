import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { scanProject } from "../src/scanner.js";
import { runConverter } from "../src/converter-core.js";
import { parsePlan, buildPlanningPrompt } from "../src/planner.js";
import { packContext } from "../src/packer.js";
import type { AnthropicClient, CallOptions, CallResult } from "../src/anthropic.js";
import { pricingFor } from "../src/util/tokens.js";
import type { MigrationPlan } from "../src/types.js";

/** Minimal AnthropicClient stand-in with scripted responses. */
class MockClient {
  calls = 0;
  usd = 0;
  inputTokens = 0;
  outputTokens = 0;
  pricing = pricingFor("claude-sonnet-4-5");
  responses: string[] = [];
  received: CallOptions[] = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async call(opts: CallOptions): Promise<CallResult> {
    this.calls++;
    this.received.push(opts);
    const text = this.responses.shift() ?? "";
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
    };
    return {
      text,
      usage,
      costUsd: 0.01,
      stopReason: "end_turn",
      model: "mock",
    };
  }
}

// The mock only needs the shape used by runConverter — asserted structurally.
const _typeCheck: AnthropicClient = new MockClient([]) as unknown as AnthropicClient;
void _typeCheck;

const PHP_APP = path.join(__dirname, "fixtures", "php-app");

function fakePlan(scan: Awaited<ReturnType<typeof scanProject>>): MigrationPlan {
  return parsePlan(
    JSON.stringify({
      target: "nextjs",
      summary: "Tiny PHP shop to Next.js",
      decisions: [{ topic: "data", choice: "server components + lib/db.ts" }],
      dependencies: ["next", "react"],
      fileMappings: [
        { source: "index.php", targets: ["app/page.tsx"], note: "home" },
        { source: "pages/users.php", targets: ["app/users/page.tsx"], note: "users table" },
        { source: "includes/db.php", targets: ["lib/db.ts"], note: "db helpers" },
      ],
      routeMappings: [{ from: "index.php?page=users", to: "/users" }],
      droppedFiles: [{ path: "style.css", reason: "replaced by globals.css" }],
      scaffoldFiles: [],
      conversionOrder: [["includes/db.php"], ["index.php", "pages/users.php"]],
      risks: [],
    }),
    "nextjs",
  );
}

function fileBlock(p: string, content: string): string {
  return `<file path="${p}">\n${content}\n</file>`;
}

function goodResponses(): string[] {
  return [
    fileBlock("lib/db.ts", "export function queryAll() { return []; }\n"),
    fileBlock("app/page.tsx", "export default function Page() { return <p>home</p>; }\n") +
      fileBlock("app/users/page.tsx", "export default function Users() { return <table id=\"users-table\" />; }\n"),
  ];
}

describe("e2e conversion (mocked Claude)", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "restack-e2e-"));
  });

  it("converts the PHP fixture end-to-end and writes scaffold + outputs", async () => {
    const scan = await scanProject(PHP_APP);
    const plan = fakePlan(scan);
    const client = new MockClient(goodResponses());

    const verifyCalls: string[][] = [];
    const outcome = await runConverter(client, scan, plan, outDir, {
      target: "nextjs",
      model: "mock",
      workers: 1,
      verifyOverride: async () => {
        // capture which files existed at verify time
        const all = await fsp.readdir(outDir, { recursive: true });
        verifyCalls.push(all as unknown as string[]);
        return { ok: true, errors: [] };
      },
    });

    expect(outcome.stats.filesConverted).toBe(3);
    expect(outcome.stats.filesFailed).toBe(0);
    expect(client.calls).toBe(2);

    const dbTs = await fsp.readFile(path.join(outDir, "lib", "db.ts"), "utf8");
    expect(dbTs).toContain("queryAll");
    const page = await fsp.readFile(path.join(outDir, "app", "page.tsx"), "utf8");
    expect(page).toContain("home");

    // Static scaffold present
    const pkg = JSON.parse(await fsp.readFile(path.join(outDir, "package.json"), "utf8"));
    expect(pkg.dependencies.next).toBeDefined();
    await fsp.access(path.join(outDir, "tsconfig.json"));
    await fsp.access(path.join(outDir, "app", "layout.tsx"));

    // Conversion system prompt included the plan tables
    const sys = client.received[0]!.system;
    expect(sys).toContain("includes/db.php");
    expect(sys).toContain("Route table");
    // User prompt carried the legacy source verbatim
    const user1 = client.received[0]!.messages[0]!;
    expect(typeof user1.content === "string" ? user1.content : "").toContain("db_connect");
  });

  it("runs the repair loop when verification fails once then passes", async () => {
    const scan = await scanProject(PHP_APP);
    const plan = fakePlan(scan);
    // Wave 1 response is broken first, fixed on repair
    const responses = [
      fileBlock("lib/db.ts", "export function queryAll( BROKEN\n"),
      fileBlock("lib/db.ts", "export function queryAll() { return []; }\n"),
      fileBlock("app/page.tsx", "export default function Page() { return <p>home</p>; }\n") +
        fileBlock("app/users/page.tsx", "export default function Users() { return <table />; }\n"),
    ];
    const client = new MockClient(responses);

    let verifyCount = 0;
    const outcome = await runConverter(client, scan, plan, outDir, {
      target: "nextjs",
      model: "mock",
      workers: 1,
      verifyOverride: async () => {
        verifyCount++;
        const text = await fsp.readFile(path.join(outDir, "lib", "db.ts"), "utf8").catch(() => "");
        if (verifyCount === 1) return { ok: false, errors: ["lib/db.ts: error TS1005: ']' expected"] };
        return { ok: text.includes("queryAll()"), errors: [] };
      },
    });

    expect(client.calls).toBe(3); // 2 convert + 1 repair
    expect(verifyCount).toBeGreaterThanOrEqual(2);
    expect(outcome.stats.filesRepaired + outcome.stats.filesConverted).toBeGreaterThanOrEqual(2);
    expect(outcome.stats.filesFailed).toBe(0);
    const dbTs = await fsp.readFile(path.join(outDir, "lib", "db.ts"), "utf8");
    expect(dbTs).toContain("queryAll()");
  });

  it("marks batches failed when verification never passes", async () => {
    const scan = await scanProject(PHP_APP);
    const plan = fakePlan(scan);
    const client = new MockClient([
      fileBlock("lib/db.ts", "export const x BROKEN\n"),
      fileBlock("lib/db.ts", "still BROKEN\n"),
      fileBlock("app/page.tsx", "fine\n") + fileBlock("app/users/page.tsx", "fine\n"),
    ]);

    const outcome = await runConverter(client, scan, plan, outDir, {
      target: "nextjs",
      model: "mock",
      workers: 1,
      maxRepairRounds: 1,
      verifyOverride: async () => ({ ok: false, errors: ["synthetic failure"] }),
    });

    expect(outcome.stats.filesFailed).toBeGreaterThan(0);
    const failed = outcome.results.find((r) => r.source === "includes/db.php");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("synthetic failure");
  });

  it("enforces the cost guard before spending", async () => {
    const scan = await scanProject(PHP_APP);
    const plan = fakePlan(scan);
    const client = new MockClient(goodResponses());
    // Each call "costs" nothing in the mock, but client.usd starts at 0 — force over budget:
    client.usd = 100;

    await expect(
      runConverter(client, scan, plan, outDir, {
        target: "nextjs",
        model: "mock",
        workers: 1,
        maxCostUsd: 5,
      }),
    ).rejects.toThrow(/Cost guard/);
    expect(client.calls).toBe(0);
  });

  it("plans with a packed prompt that fits the context window", async () => {
    const scan = await scanProject(PHP_APP);
    const packed = packContext(scan, { tokenBudget: 160_000 });
    const prompt = buildPlanningPrompt(scan, "nextjs");
    const total = packed.tokens + prompt.length / 3.8;
    expect(total).toBeLessThan(180_000);
    // The .env fixture must never appear with content in the packed context
    expect(packed.text).not.toContain("supersecret123");
    expect(packed.text).toContain("Sensitive files excluded");
  });
});
