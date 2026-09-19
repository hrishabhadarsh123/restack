/**
 * Shared types for scan results, migration plans, and conversion state.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export const LegacyStack = z.enum(["php-jquery", "python2", "unknown"]);
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
