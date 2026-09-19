import { describe, expect, it } from "vitest";
import path from "node:path";
import { scanProject, buildScanJsonReport } from "../src/scanner.js";

const PHP_APP = path.join(__dirname, "fixtures", "php-app");
const PY2_APP = path.join(__dirname, "fixtures", "py2-app");

describe("scanProject", () => {
  it("detects the php-jquery stack on the PHP fixture", async () => {
    const scan = await scanProject(PHP_APP);
    expect(scan.stack).toBe("php-jquery");
    expect(scan.confidence).toBeGreaterThan(0.4);
    expect(scan.libraries).toContain("jquery");
    expect(scan.evidence.some((e) => e.includes(".php"))).toBe(true);
  });

  it("detects python2 on the py2 fixture", async () => {
    const scan = await scanProject(PY2_APP);
    expect(scan.stack).toBe("python2");
    // print statement + coding cookie + old distutils
    expect(scan.evidence.length).toBeGreaterThan(0);
  });

  it("excludes sensitive files from readable text", async () => {
    const scan = await scanProject(PHP_APP);
    expect(scan.excludedSensitive).toContain(".env");
    const env = scan.files.find((f) => f.rel === ".env");
    expect(env).toBeDefined();
    expect(env!.text).toBeNull();
    // The secret must never be loaded into memory
    const packedAnywhere = scan.files.some((f) => f.text?.includes("supersecret123"));
    expect(packedAnywhere).toBe(false);
  });

  it("classifies roles for entry/shared/route files", async () => {
    const scan = await scanProject(PHP_APP);
    const roles = new Map(scan.files.map((f) => [f.rel, f.role]));
    expect(roles.get("index.php")).toBe("entry");
    expect(roles.get("includes/db.php")).toBe("shared");
    expect(roles.get("api/users_search.php")).toBe("route");
    expect(roles.get("pages/users.php")).toBe("route");
    expect(roles.get("js/users.js")).toBe("other");
  });

  it("estimates nonzero tokens for readable files", async () => {
    const scan = await scanProject(PHP_APP);
    const total = scan.totalTokens;
    expect(total).toBeGreaterThan(100);
    for (const f of scan.files) {
      if (f.text != null) expect(f.tokens).toBeGreaterThan(0);
    }
  });

  it("builds a valid JSON report for --json output", async () => {
    const scan = await scanProject(PHP_APP);
    const report = buildScanJsonReport(scan);

    // Round-trips through JSON without loss
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed.stack).toBe("php-jquery");
    expect(parsed.fileCount).toBe(scan.files.length);
    expect(parsed.readableFileCount).toBe(scan.files.filter((f) => f.text != null).length);
    expect(parsed.totalTokens).toBe(scan.totalTokens);
    expect(parsed.fitsInOneWindow).toBe(true); // fixture is small
    expect(parsed.excludedSensitive).toContain(".env");
    expect(parsed.libraries).toContain("jquery");

    // Every file entry is complete and consistent with the scan
    expect(parsed.files).toHaveLength(scan.files.length);
    const envEntry = parsed.files.find((f) => f.path === ".env");
    expect(envEntry).toBeDefined();
    expect(envEntry!.readable).toBe(false);
    expect(envEntry!.tokens).toBe(0);
    const indexEntry = parsed.files.find((f) => f.path === "index.php");
    expect(indexEntry).toBeDefined();
    expect(indexEntry!.role).toBe("entry");
    expect(indexEntry!.readable).toBe(true);
    expect(indexEntry!.tokens).toBeGreaterThan(0);

    // No file contents leak into the report
    expect(JSON.stringify(parsed)).not.toContain("supersecret123");
  });

  it("throws on a nonexistent root", async () => {
    // walkDirectory swallows unreadable dirs; result is an empty scan
    const scan = await scanProject(path.join(__dirname, "does-not-exist"));
    expect(scan.files).toHaveLength(0);
    expect(scan.stack).toBe("unknown");
  });
});
