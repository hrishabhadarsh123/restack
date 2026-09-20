/**
 * Shared types for scan results, migration plans, and conversion state.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export const LegacyStack = z.enum(["php-jquery", "python2", "django", "unknown"]);
export type LegacyStack = z.infer<typeof LegacyStack>;

export const ModernTarget = z.enum(["nextjs", "fastapi"]);
export type ModernTarget = z.infer<typeof ModernTarget>;

export interface FileEntry {
  /** Path relative to project root (forward slashes). */
  rel: string;
  size: number;
  /** Estimated tokens (chars / CHARS_PER_TOKEN). */
  tokens: number;
  language: string;
  role: FileRole;
  /** null if the file was not readable (binary, too big). */
  text: string | null;
}

export type FileRole =
  | "entry"
  | "route"
  | "config"
  | "shared"
  | "template"
  | "component"
  | "style"
  | "test"
  | "other";

export interface ScanResult {
  root: string;
  stack: LegacyStack;
  /** Human-facing evidence lines, e.g. "composer.json present". */
  evidence: string[];
  confidence: number;
  files: FileEntry[];
  totalTokens: number;
  /** Detected frameworks/libraries, e.g. "jquery", "bootstrap", "django". */
  libraries: string[];
  /** Relative paths that were excluded because they looked sensitive. */
  excludedSensitive: string[];
  /** Relative paths skipped for being oversized (never read into context). */
  oversizedFiles: string[];
}

/**
 * Legacy-stack-specific guidance injected into conversion prompts so the
 * converter knows which idioms to expect beyond the generic target profile.
 */
export const STACK_CONVERSION_NOTES: Record<Exclude<LegacyStack, "unknown">, string> = {
  "php-jquery": `## Legacy stack notes (PHP + jQuery)
- Expect mysql_* / mysqli / PDO snippets, include/require composition and jQuery DOM manipulation.
- mysql_* calls have no modern equivalent: route them through the central db module with parameterized queries.
- Preserve XSS-safety: legacy echo of user input must become escaped/typed React output.`,

  python2: `## Legacy stack notes (Python 2)
- Expect print statements, xrange/iteritems, except X, e syntax, coding cookies and str/bytes confusion.
- Modernize to Python 3 idioms: f-strings, pathlib, generators, explicit encoding.`,

  django: `## Legacy stack notes (Django)
- models.py classes map to SQLAlchemy 2.0 declarative models; add matching Pydantic schemas per model (ModelOut/ModelIn).
- urls.py path patterns map to FastAPI APIRouter routes: convert <int:pk> style converters to typed path parameters.
- views.py functions become route handlers; forms.py becomes Pydantic request models.
- settings.py constants become pydantic-settings configuration read from the environment.
- manage.py commands become small CLI entry points — note them in the plan.`,
};

// ---------------------------------------------------------------------------
// Plan (phase 1 output)
// ---------------------------------------------------------------------------

export const MigrationPlanSchema = z.object({
  target: ModernTarget,
  summary: z.string(),
  /** Key architectural decisions for the new codebase. */
  decisions: z.array(z.object({ topic: z.string(), choice: z.string() })),
  /** Packages/dependencies the new project needs. */
  dependencies: z.array(z.string()),
  /** How legacy files map to new files. */
  fileMappings: z.array(
    z.object({
      source: z.string(),
      targets: z.array(z.string()),
      note: z.string(),
    }),
  ),
  /** URL/module routing table. */
  routeMappings: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      method: z.string().optional(),
    }),
  ),
  /** Legacy files with no modern equivalent (dropped or replaced). */
  droppedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** New files that must exist even without a legacy counterpart. */
  scaffoldFiles: z.array(z.object({ path: z.string(), purpose: z.string() })),
  /** Migration order: source paths grouped by waves; earlier waves first. */
  conversionOrder: z.array(z.array(z.string())),
  risks: z.array(z.string()),
});
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  path: string;
  content: string;
  /** Source rel-path it was derived from, if any. */
  derivedFrom?: string;
}

export interface FileResult {
  source: string;
  outputs: GeneratedFile[];
  status: "converted" | "repaired" | "failed" | "skipped" | "dropped";
  attempts: number;
  error?: string;
}

export interface ConvertStats {
  filesConverted: number;
  filesRepaired: number;
  filesFailed: number;
  filesDropped: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Machine-readable reports (plan/convert --json)
// ---------------------------------------------------------------------------

/** Bump when a --json payload changes in a breaking way. */
export const REPORT_SCHEMA_VERSION = 1;

export interface PlanJsonReport {
  schema: number;
  root: string;
  target: ModernTarget;
  stack: LegacyStack;
  /** Short hash tying the report to a .restack/plan.json + state. */
  planHash?: string;
  summary: string;
  decisions: Array<{ topic: string; choice: string }>;
  dependencies: string[];
  fileMappings: Array<{ source: string; targets: string[]; note: string }>;
  routeMappings: Array<{ from: string; to: string; method?: string }>;
  droppedFiles: Array<{ path: string; reason: string }>;
  /** conversionOrder as saved in the plan (dependency waves). */
  waves: string[][];
  risks: string[];
  estimatedCostUsd?: number;
  calls?: number;
}

export interface ConvertSummary {
  filesConverted: number;
  filesRepaired: number;
  filesFailed: number;
  filesDropped: number;
  calls: number;
  usd: number;
  durationMs: number;
}

/**
 * Newline-delimited JSON events streamed to stdout by `convert --json`.
 * Human logs stay on stderr; each line is self-describing (schema + event).
 */
export type ConvertEvent =
  | { schema: number; event: "run"; target: ModernTarget; outDir: string; batches: number; waves: number }
  | { schema: number; event: "wave"; index: number }
  | { schema: number; event: "batch_start"; sources: string[] }
  | {
      schema: number;
      event: "batch_complete";
      sources: string[];
      statuses: Record<string, FileResult["status"]>;
      calls: number;
      usd: number;
    }
  | {
      schema: number;
      event: "file";
      source: string;
      status: FileResult["status"];
      outputs: string[];
      attempts: number;
      error?: string;
    }
  | { schema: number; event: "warning"; message: string }
  | { schema: number; event: "summary"; stats: ConvertSummary };
