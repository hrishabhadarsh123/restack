import { describe, expect, it } from "vitest";
import { packContext } from "../src/packer.js";
import type { ScanResult, FileEntry } from "../src/types.js";

function makeFile(rel: string, tokens: number, role: FileEntry["role"] = "other"): FileEntry {
  // ~3.8 chars per token
  const text = "x".repeat(Math.max(1, Math.round(tokens * 3.8)));
  return { rel, size: text.length, tokens, language: "php", role, text };
}

function makeScan(files: FileEntry[]): ScanResult {
  return {
    root: "/tmp/proj",
    stack: "php-jquery",
    evidence: [],
    confidence: 0.9,
    files,
    totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    libraries: [],
    excludedSensitive: [],
    oversizedFiles: [],
  };
}

describe("packContext", () => {
  it("packs a small project fully verbatim", () => {
    const scan = makeScan([
      makeFile("index.php", 200, "entry"),
      makeFile("includes/db.php", 300, "shared"),
      makeFile("pages/users.php", 400, "route"),
    ]);
    const packed = packContext(scan, { tokenBudget: 100_000 });
    expect(packed.verbatim).toEqual(
      expect.arrayContaining(["index.php", "includes/db.php", "pages/users.php"]),
    );
    expect(packed.summarized).toHaveLength(0);
    expect(packed.omitted).toHaveLength(0);
    expect(packed.tokens).toBeLessThan(5_000);
    expect(packed.text).toContain('<file path="index.php">');
  });

  it("respects the budget: drops low-priority files first", () => {
    const files: FileEntry[] = [
      makeFile("index.php", 2_000, "entry"),
      makeFile("includes/db.php", 2_000, "shared"),
      makeFile("style/a.css", 30_000, "style"),
      makeFile("test/a.spec.php", 30_000, "test"),
    ];
    const packed = packContext(makeScan(files), { tokenBudget: 10_000 });
    // entry + shared must survive; style/test are the first to go
    expect(packed.verbatim).toContain("index.php");
    expect(packed.verbatim).toContain("includes/db.php");
    expect(packed.omitted.length + packed.summarized.length).toBeGreaterThan(0);
    expect(packed.text.length / 3.8).toBeLessThan(11_000);
  });

  it("summarizes oversized files instead of omitting them", () => {
    const scan = makeScan([
      makeFile("huge.php", 20_000, "route"),
      makeFile("small.php", 500, "route"),
    ]);
    const packed = packContext(scan, { tokenBudget: 30_000, verbatimMaxTokens: 3_500 });
    expect(packed.summarized).toContain("huge.php");
    expect(packed.verbatim).toContain("small.php");
    expect(packed.text).toContain("SUMMARIZED");
    expect(packed.text).toContain("middle truncated");
  });

  it("prioritizes entry/config over styles within a tight budget", () => {
    const files: FileEntry[] = [
      makeFile("style/x.css", 4_000, "style"),
      makeFile("index.php", 4_000, "entry"),
    ];
    const packed = packContext(makeScan(files), { tokenBudget: 5_000 });
    expect(packed.verbatim).toContain("index.php");
    expect(packed.verbatim).not.toContain("style/x.css");
  });

  it("includes an inventory listing every file, with a note for truly omitted ones", () => {
    const scan = makeScan([
      makeFile("index.php", 2_000, "entry"),
      makeFile("style/a.css", 40_000, "style"),
      makeFile("test/big.spec.php", 30_000, "test"),
    ]);
    // Budget: entry verbatim eats most of it; one file gets a tiny summary;
    // the last one has no summary room left and is omitted entirely.
    const packed = packContext(scan, { tokenBudget: 5_000 });
    expect(packed.text).toContain("- style/a.css");
    expect(packed.text).toContain("- test/big.spec.php");
    expect(packed.text).toContain("NOT included in the source section");
    expect(packed.omitted.length).toBeGreaterThan(0);
  });

  it("never exceeds the overall token budget", () => {
    const scan = makeScan([
      makeFile("index.php", 20_000, "entry"),
      makeFile("a.php", 15_000, "route"),
      makeFile("b.php", 15_000, "route"),
      makeFile("c.css", 25_000, "style"),
    ]);
    const packed = packContext(scan, { tokenBudget: 50_000 });
    expect(packed.tokens).toBeLessThanOrEqual(51_000);
  });
});
