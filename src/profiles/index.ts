/**
 * Target profiles: conventions, prompts and per-target verification for the
 * two supported conversions.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { ModernTarget } from "../types.js";

export interface VerifyContext {
  outDir: string;
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

export interface TargetProfile {
  id: ModernTarget;
  label: string;
  /** Short conventions block injected into conversion system prompts. */
  conventions: string;
  /** Extra user-prompt guidance for the planner. */
  planningHints: string;
  /** Files generated verbatim (not by Claude). */
  staticScaffold?: Array<{ path: string; content: string }>;
  /** Verify generated output: returns error list for the repair loop. */
  verify(ctx: VerifyContext): Promise<VerifyResult>;
  /** Package manifest path for the target (used for dependency install hints). */
  manifestPath: string;
  /** Command hint shown to the user after conversion. */
  runInstructions: string;
}

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------

const NEXTJS_CONVENTIONS = `## Next.js (App Router) + TypeScript conventions
- Output ONLY files inside the project: e.g. "app/page.tsx", "app/api/users/route.ts", "lib/db.ts", "components/UserTable.tsx".
- TypeScript strict mode: no implicit any, explicit return types on exported functions.
- Server Components by default; add "use client" ONLY when a component uses hooks/handlers (convert jQuery click handlers to React state).
- Data fetching: server components fetch directly; API routes under app/api/*/route.ts export GET/POST handlers.
- Styling: convert legacy CSS to CSS Modules (*.module.css) when names collide; keep global styles in app/globals.css.
- No direct SQL string concatenation: use parameterized queries or an ORM snippet; environment-based config via process.env.
- Never emit package.json/tsconfig.json/node_modules — the scaffold provides them. Focus on app/, lib/, components/.`;

const NEXTJS_PLANNING_HINTS = `Plan for Next.js 15 App Router + TypeScript strict:
- Map each legacy page/endpoint to a route: pages -> app/<route>/page.tsx, JSON endpoints -> app/api/<name>/route.ts.
- Shared PHP includes (header/footer) become layout.tsx + components/.
- jQuery behaviors become client components with hooks; list which pages need "use client".
- DB access (mysqli/PDO) centralizes into lib/db.ts.
- Static assets stay under public/.`;

function nextjsStaticScaffold(): Array<{ path: string; content: string }> {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: "converted-app",
          version: "0.1.0",
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: {
            next: "^15.0.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
          },
          devDependencies: {
            typescript: "^5.9.2",
            "@types/node": "^24.0.0",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] },
          },
          include: ["**/*.ts", "**/*.tsx", "next-env.d.ts", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      ) + "\n",
    },
    {
      path: "next.config.mjs",
      content: `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nexport default nextConfig;\n`,
    },
    {
      path: "app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Converted App" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: "app/globals.css",
      content: `:root { color-scheme: light dark; }\n\nbody { margin: 0; font-family: system-ui, sans-serif; }\n`,
    },
  ];
}

// ---------------------------------------------------------------------------
// FastAPI
// ---------------------------------------------------------------------------

const FASTAPI_CONVENTIONS = `## FastAPI + Python 3.12 conventions
- Output ONLY files inside the project: e.g. "main.py", "routers/users.py", "models.py", "schemas.py", "database.py".
- Pydantic v2 BaseModel schemas for requests/responses; SQLAlchemy 2.0 style for ORM.
- Async def for route handlers unless blocked on a sync-only driver.
- Routers under routers/ with APIRouter(prefix=...); app assembly in main.py.
- Type hints everywhere (python -X dev strictness): no bare except, no print debugging.
- Config via pydantic-settings reading environment variables.
- Never emit requirements.txt/pyproject.toml — the scaffold provides them.`;

const FASTAPI_PLANNING_HINTS = `Plan for FastAPI + Pydantic v2 + SQLAlchemy 2.0:
- Map each legacy module/CGI script to a router: routers/<domain>.py.
- print-based scripts become endpoints or CLI commands (decide and note it).
- Python 2 idioms must be modernized: iterators/generators, f-strings, pathlib, dataclasses.
- DB layer (MySQLdb/psycopg2 raw) centralizes into database.py with SQLAlchemy engine + sessions.
- Static/templates only if genuinely needed (Jinja2 via fastapi static files).`;

function fastapiStaticScaffold(): Array<{ path: string; content: string }> {
  return [
    {
      path: "requirements.txt",
      content: "fastapi>=0.115\nuvicorn[standard]>=0.32\npydantic>=2.9\npydantic-settings>=2.6\nsqlalchemy>=2.0\n\n# dev\nruff>=0.7\nmypy>=1.13\n",
    },
    {
      path: "pyproject.toml",
      content: `[project]
name = "converted-app"
version = "0.1.0"
requires-python = ">=3.12"

[tool.ruff]
line-length = 110
target-version = "py312"

[tool.mypy]
strict = true
python_version = "3.12"
`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROFILES: Record<ModernTarget, TargetProfile> = {
  nextjs: {
    id: "nextjs",
    label: "Next.js (App Router) + TypeScript",
    conventions: NEXTJS_CONVENTIONS + "\n\n" + NEXTJS_PLANNING_HINTS,
    planningHints: NEXTJS_PLANNING_HINTS,
    staticScaffold: nextjsStaticScaffold(),
    manifestPath: "package.json",
    runInstructions: "cd <outDir> && npm install && npm run dev",
    verify: verifyNextjs,
  },
  fastapi: {
    id: "fastapi",
    label: "FastAPI + Pydantic v2",
    conventions: FASTAPI_CONVENTIONS + "\n\n" + FASTAPI_PLANNING_HINTS,
    planningHints: FASTAPI_PLANNING_HINTS,
    staticScaffold: fastapiStaticScaffold(),
    manifestPath: "requirements.txt",
    runInstructions: "cd <outDir> && python -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn main:app --reload",
    verify: verifyFastapi,
  },
};

export function getProfile(target: ModernTarget): TargetProfile {
  const p = PROFILES[target];
  if (!p) throw new Error(`Unknown target: ${target}`);
  return p;
}

// ---------------------------------------------------------------------------
// Verification implementations
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** Find a usable TypeScript compiler: node_modules first, then npx fallback. */
async function findTsc(outDir: string): Promise<{ cmd: string; args: string[] } | null> {
  const local = path.join(outDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.CMD" : "tsc");
  if (await fileExists(local)) return { cmd: local, args: [] };
  const global = await run("tsc", ["--version"], process.cwd(), 15_000);
  if (global.code === 0) return { cmd: "tsc", args: [] };
  return null;
}

async function verifyNextjs(ctx: VerifyContext): Promise<VerifyResult> {
  const errors: string[] = [];
  const tsFiles = await collectByExt(ctx.outDir, [".ts", ".tsx"]);
  if (tsFiles.length === 0) {
    return { ok: true, errors: [] };
  }
  const tsc = await findTsc(ctx.outDir);
  if (!tsc) {
    // No tsc anywhere — fall back to syntax sanity via node --check on stripped content? Not reliable.
    // Do a lightweight brace-balance check instead.
    for (const f of tsFiles) {
      const text = await fsp.readFile(f, "utf8");
      const balanced = balanceCheck(text);
      if (!balanced) errors.push(`${path.relative(ctx.outDir, f)}: unbalanced braces/brackets (syntax)`);
    }
    return { ok: errors.length === 0, errors };
  }
  const res = await run(tsc.cmd, [...tsc.args, "--noEmit", "--pretty", "false"], ctx.outDir);
  if (res.code !== 0) {
    for (const line of (res.stdout + "\n" + res.stderr).split("\n")) {
      const t = line.trim();
      if (/error TS\d+/.test(t)) errors.push(t);
    }
    if (errors.length === 0) errors.push("tsc failed with no parsable errors: " + (res.stderr || res.stdout).slice(0, 400));
  }
  return { ok: errors.length === 0, errors };
}

async function verifyFastapi(ctx: VerifyContext): Promise<VerifyResult> {
  const errors: string[] = [];
  const pyFiles = await collectByExt(ctx.outDir, [".py"]);
  if (pyFiles.length === 0) return { ok: true, errors: [] };

  // 1) ast.parse each file (syntax check, no deps needed beyond python)
  const python = await findPython();
  if (!python) {
    errors.push("python not found on PATH; cannot verify syntax");
    return { ok: false, errors };
  }
  const checker = path.join(ctx.outDir, ".restack_syntax_check.py");
  await fsp.writeFile(
    checker,
    `import ast, sys
paths = sys.argv[1:]
failed = False
for p in paths:
    try:
        with open(p, "r", encoding="utf-8") as fh:
            ast.parse(fh.read(), filename=p)
    except SyntaxError as e:
        print(f"{e.filename}:{e.lineno}: syntax error: {e.msg}")
        failed = True
sys.exit(1 if failed else 0)
`,
    "utf8",
  );
  const astRes = await run(python, [checker, ...pyFiles], ctx.outDir);
  await fsp.rm(checker, { force: true }).catch(() => {});
  if (astRes.code !== 0) {
    for (const line of astRes.stdout.split("\n")) {
      const t = line.trim();
      if (t) errors.push(t);
    }
  }

  // 2) If fastapi/pydantic are importable, do an import smoke test on main.py
  const impRes = await run(python, ["-c", "import fastapi, pydantic"], ctx.outDir, 20_000);
  if (impRes.code === 0) {
    const mainExists = await fileExists(path.join(ctx.outDir, "main.py"));
    if (mainExists) {
      const importRes = await run(
        python,
        ["-c", "import main"],
        ctx.outDir,
        30_000,
      );
      if (importRes.code !== 0) {
        errors.push("import main failed:\n" + (importRes.stderr || importRes.stdout).slice(0, 1000));
      }
      // Clean up __pycache__ created by the import test
      await fsp.rm(path.join(ctx.outDir, "__pycache__"), { recursive: true, force: true }).catch(() => {});
    }
  }
  return { ok: errors.length === 0, errors };
}

async function findPython(): Promise<string | null> {
  for (const candidate of ["python3", "python"]) {
    const res = await run(candidate, ["--version"], process.cwd(), 10_000);
    if (res.code === 0) return candidate;
  }
  return null;
}

async function collectByExt(root: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".venv" || e.name === "__pycache__") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(abs);
      } else if (exts.includes(path.posix.extname(e.name).toLowerCase())) {
        out.push(abs);
      }
    }
  }
  await rec(root);
  return out;
}

/** Cheap heuristic: balanced (), {}, [] outside strings/comments. */
function balanceCheck(text: string): boolean {
  let depth = 0;
  let inStr: string | null = null;
  let escaped = false;
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inComment) {
      if (c === "\n") inComment = false;
      continue;
    }
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") inComment = true;
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}
