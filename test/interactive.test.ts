/**
 * Interactive mode tests: pure helpers (applySelections, cost estimator,
 * convertibleSources) plus the non-TTY contract — `--interactive` must never
 * hang or prompt in CI; it warns and falls back to the plain flow.
 */
import { describe, expect, it } from "vitest";
import {
  applySelections,
  convertibleSources,
  estimateConversionCostUsd,
  isInteractiveTTY,
} from "../src/interactive.js";
import type { MigrationPlan, ScanResult } from "../src/types.js";
import { PRICING } from "../src/util/tokens.js";

function makePlan(): MigrationPlan {
  return {
    target: "nextjs",
    summary: "s",
    decisions: [],
    dependencies: [],
    fileMappings: [
      { source: "index.php", targets: ["app/page.tsx"], note: "" },
      { source: "db.php", targets: ["lib/db.ts"], note: "" },
      { source: "legacy.js", targets: [], note: "dropped" },
    ],
    routeMappings: [
      { from: "/index.php", to: "/" },
      { from: "/users.php", to: "/users" },
    ],
    droppedFiles: [],
    scaffoldFiles: [],
    conversionOrder: [["db.php", "index.php"]],
    risks: [],
  };
}

const scanStub = {
  root: "/x",
  stack: "php-jquery" as const,
  confidence: 1,
  evidence: [],
  libraries: [],
  files: [
    { rel: "index.php", size: 76_000, tokens: 20_000, language: "php", role: "route" as const, text: "x" },
    { rel: "db.php", size: 76_000, tokens: 20_000, language: "php", role: "shared" as const, text: "x" },
  ],
  totalTokens: 40_000,
  excludedSensitive: [],
  oversizedFiles: [],
} satisfies ScanResult;

describe("interactive helpers", () => {
  it("convertibleSources lists only mappings with targets", () => {
    expect(convertibleSources(makePlan())).toEqual(["index.php", "db.php"]);
  });

  it("applySelections trims mappings, routes and empty waves", () => {
    const plan = applySelections(makePlan(), {
      excludedSources: ["db.php"],
      droppedRoutes: ["/users.php"],
    });
    expect(plan.fileMappings.map((m) => m.source)).toEqual(["index.php", "legacy.js"]);
    expect(plan.routeMappings.map((r) => r.from)).toEqual(["/index.php"]);
    expect(plan.conversionOrder).toEqual([["index.php"]]);
  });

  it("applySelections keeps empty-wave filtering honest when everything is excluded", () =>
  {
    const plan = applySelections(makePlan(), {
      excludedSources: ["index.php", "db.php"],
      droppedRoutes: [],
    });
    expect(plan.conversionOrder).toEqual([]);
  });

  it("estimateConversionCostUsd scales with the selected subset", () => {
    const pricing = PRICING["claude-sonnet-4-5"]!;
    const full = estimateConversionCostUsd(scanStub, makePlan(), pricing);
    const subset = estimateConversionCostUsd(
      scanStub,
      applySelections(makePlan(), { excludedSources: ["db.php"], droppedRoutes: [] }),
      pricing,
    );
    expect(full.batches).toBe(2); // wave members split across batch-size/token limits
    expect(subset.batches).toBe(1);
    expect(subset.usd).toBeLessThan(full.usd);
    expect(subset.usd).toBeGreaterThan(0);
  });

  it("isInteractiveTTY is false in test runners (non-TTY contract)", () => {
    expect(isInteractiveTTY()).toBe(false);
  });
});
