import { describe, expect, it } from "vitest";
import { parsePlan, buildPlanJsonReport } from "../src/planner.js";
import type { ScanResult } from "../src/types.js";

const validPlan = {
  target: "nextjs",
  summary: "Convert a tiny PHP shop",
  decisions: [{ topic: "auth", choice: "cookie sessions" }],
  dependencies: ["next", "react"],
  fileMappings: [{ source: "index.php", targets: ["app/page.tsx"], note: "home" }],
  routeMappings: [{ from: "index.php?page=users", to: "/users" }],
  droppedFiles: [],
  scaffoldFiles: [],
  conversionOrder: [["index.php"]],
  risks: [],
};

describe("parsePlan", () => {
  it("accepts a clean JSON object", () => {
    const plan = parsePlan(JSON.stringify(validPlan), "nextjs");
    expect(plan.summary).toBe("Convert a tiny PHP shop");
    expect(plan.fileMappings[0]!.source).toBe("index.php");
  });

  it("tolerates markdown fences", () => {
    const wrapped = "```json\n" + JSON.stringify(validPlan, null, 2) + "\n```";
    const plan = parsePlan(wrapped, "nextjs");
    expect(plan.target).toBe("nextjs");
  });

  it("tolerates surrounding prose", () => {
    const noisy = "Here is the plan you asked for:\n" + JSON.stringify(validPlan) + "\nLet me know if...";
    const plan = parsePlan(noisy, "nextjs");
    expect(plan.decisions[0]!.topic).toBe("auth");
  });

  it("throws on output with no JSON", () => {
    expect(() => parsePlan("sorry I cannot", "nextjs")).toThrow(/no JSON object/);
  });

  it("throws on schema violations", () => {
    const bad = { ...validPlan, fileMappings: "not-an-array" };
    expect(() => parsePlan(JSON.stringify(bad), "nextjs")).toThrow(/validation/);
  });

  it("overrides a wrong target with a warning", () => {
    const wrong = { ...validPlan, target: "fastapi" };
    const plan = parsePlan(JSON.stringify(wrong), "nextjs");
    expect(plan.target).toBe("nextjs");
  });
});

describe("buildPlanJsonReport", () => {
  const fakeScan = {
    root: "/tmp/legacy",
    stack: "php-jquery",
    confidence: 0.8,
    evidence: [],
    files: [],
    totalTokens: 10,
    libraries: [],
    excludedSensitive: [],
    oversizedFiles: [],
  } as unknown as ScanResult;

  it("builds a schema-versioned, JSON-round-trippable report", () => {
    const plan = parsePlan(JSON.stringify(validPlan), "nextjs");
    const report = buildPlanJsonReport(fakeScan, plan, {
      planHash: "abc123",
      usd: 0.05,
      calls: 1,
    });

    expect(report.schema).toBe(1);
    expect(report.target).toBe("nextjs");
    expect(report.stack).toBe("php-jquery");
    expect(report.planHash).toBe("abc123");
    expect(report.estimatedCostUsd).toBe(0.05);
    expect(report.calls).toBe(1);
    expect(report.waves).toEqual(["index.php"].map((s) => [s]));
    expect(report.fileMappings).toHaveLength(1);
    expect(report.summary).toBe("Convert a tiny PHP shop");

    // Round-trips through NDJSON/HTTP unchanged
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("keeps meta fields optional", () => {
    const plan = parsePlan(JSON.stringify(validPlan), "nextjs");
    const report = buildPlanJsonReport(fakeScan, plan, {});
    expect(report.planHash).toBeUndefined();
    expect(report.estimatedCostUsd).toBeUndefined();
  });
});
