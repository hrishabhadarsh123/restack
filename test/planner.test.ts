import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/planner.js";

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
