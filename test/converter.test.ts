import { describe, expect, it } from "vitest";
import { buildConversionBatches, parseGeneratedFiles } from "../src/converter.js";
import type { MigrationPlan, ScanResult, FileEntry } from "../src/types.js";

function file(rel: string, tokens: number): FileEntry {
  return { rel, size: tokens * 4, tokens, language: "php", role: "route", text: "code" };
}

describe("buildConversionBatches", () => {
  const plan: MigrationPlan = {
    target: "nextjs",
    summary: "s",
    decisions: [],
    dependencies: [],
    fileMappings: [
      { source: "a.php", targets: ["app/a/page.tsx"], note: "" },
      { source: "b.php", targets: ["app/b/page.tsx"], note: "" },
      { source: "c.php", targets: ["app/c/page.tsx"], note: "" },
      { source: "gone.php", targets: [], note: "" },
    ],
    routeMappings: [],
    droppedFiles: [],
    scaffoldFiles: [],
    conversionOrder: [["a.php", "b.php", "c.php", "gone.php"]],
    risks: [],
  };

  it("splits waves into batches of at most 3 sources", () => {
    const scan = {
      files: [file("a.php", 100), file("b.php", 100), file("c.php", 100), file("gone.php", 10)],
    } as ScanResult;
    const batches = buildConversionBatches(scan, plan);
    expect(batches).toEqual([["a.php", "b.php", "c.php"]]);
    // gone.php is not in fileMappings -> skipped
  });

  it("respects the token cap per batch", () => {
    const scan = {
      files: [file("a.php", 20_000), file("b.php", 20_000)],
    } as ScanResult;
    const plan2: MigrationPlan = {
      ...plan,
      fileMappings: [
        { source: "a.php", targets: ["x.tsx"], note: "" },
        { source: "b.php", targets: ["y.tsx"], note: "" },
      ],
      conversionOrder: [["a.php", "b.php"]],
    };
    const batches = buildConversionBatches(scan, plan2);
    expect(batches).toEqual([["a.php"], ["b.php"]]);
  });

  it("warns and skips files missing from the scan", () => {
    const scan = { files: [file("a.php", 100)] } as ScanResult;
    const batches = buildConversionBatches(scan, plan);
    expect(batches).toEqual([["a.php"]]);
  });

  it("skips sources passed via skipSources (resume support)", () => {
    const scan = {
      files: [file("a.php", 100), file("b.php", 100), file("c.php", 100)],
    } as ScanResult;
    const batches = buildConversionBatches(scan, plan, new Set(["a.php", "b.php"]));
    expect(batches).toEqual([["c.php"]]);
  });
});

describe("parseGeneratedFiles", () => {
  it("parses simple tagged output", () => {
    const text = `Here are the files:
<file path="app/page.tsx">
export default function Page() { return <p>hi</p>; }
</file>
<file path="lib/db.ts">
export const db = {};
</file>`;
    const files = parseGeneratedFiles(text);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "app/page.tsx" });
    expect(files[0]!.content).toContain("export default function Page");
    expect(files[1]!.content).toContain("export const db");
  });

  it("rejects path traversal and absolute paths", () => {
    const text = `<file path="../evil.ts">
nope
</file>
<file path="/abs/path.ts">
nope
</file>
<file path="ok.ts">
yes
</file>`;
    const files = parseGeneratedFiles(text);
    expect(files.map((f) => f.path)).toEqual(["ok.ts"]);
  });

  it("returns empty for garbage output", () => {
    expect(parseGeneratedFiles("no files here")).toEqual([]);
    expect(parseGeneratedFiles("")).toEqual([]);
  });

  it("keeps multiline content with nested tags intact", () => {
    const text = `<file path="a.tsx">
const html = "<file path='fake'>not a block</file>";
</file>`;
    const files = parseGeneratedFiles(text);
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain("not a block");
  });
});
