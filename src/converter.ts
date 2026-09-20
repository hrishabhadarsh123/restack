/**
 * Converter (pass 2): converts files in plan.conversionOrder waves, batches
 * related sources, parses tagged output, runs per-batch verification and a
 * bounded repair loop.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import { getProfile } from "./profiles/index.js";
import { STACK_CONVERSION_NOTES } from "./types.js";
import type { FileResult, GeneratedFile, LegacyStack, MigrationPlan, ModernTarget, ScanResult } from "./types.js";
import { logger } from "./util/logger.js";
import { estimateTokens } from "./util/tokens.js";
import { CostLimitError } from "./state.js";

export interface ConvertOptions {
  target: ModernTarget;
  model: string;
  workers: number;
  maxCostUsd?: number;
  maxRepairRounds?: number;
  onBatchComplete?: (results: FileResult[]) => void;
}

export interface ConvertOutcome {
  results: FileResult[];
  scaffoldWritten: string[];
  stats: {
    filesConverted: number;
    filesRepaired: number;
    filesFailed: number;
    filesDropped: number;
    calls: number;
    usd: number;
  };
}

const BATCH_MAX_SOURCES = 3;
const BATCH_MAX_TOKENS = 24_000;
const OUTPUT_RESERVE = 24_000;

export function buildConversionBatches(
  scan: ScanResult,
  plan: MigrationPlan,
  skipSources?: Set<string>,
): string[][] {
  // Sources with at least one target path actually need generation.
  const convertible = new Set(
    plan.fileMappings.filter((m) => m.targets.length > 0).map((m) => m.source),
  );
  const byRel = new Map(scan.files.map((f) => [f.rel, f] as const));
  const batches: string[][] = [];
  for (const wave of plan.conversionOrder) {
    let cur: string[] = [];
    let curTokens = 0;
    for (const rel of wave) {
      if (!convertible.has(rel) || skipSources?.has(rel)) continue;
      const f = byRel.get(rel);
      if (!f || f.text == null) {
        logger.warn(`Planner referenced unreadable file: ${rel}`);
        continue;
      }
      if (cur.length > 0 && (cur.length >= BATCH_MAX_SOURCES || curTokens + f.tokens > BATCH_MAX_TOKENS)) {
        batches.push(cur);
        cur = [];
        curTokens = 0;
      }
      cur.push(rel);
      curTokens += f.tokens;
    }
    if (cur.length > 0) batches.push(cur);
  }
  return batches;
}

export function buildConversionSystemPrompt(
  plan: MigrationPlan,
  target: ModernTarget,
  legacyStack?: LegacyStack,
): string {
  const profile = getProfile(target);
  const stackNote =
    legacyStack && legacyStack !== "unknown" ? STACK_CONVERSION_NOTES[legacyStack] : undefined;
  const routeTable = plan.routeMappings
    .map((r) => `- ${r.method ? r.method + " " : ""}${r.from} -> ${r.to}`)
    .join("\n");
  const mappingTable = plan.fileMappings
    .map((m) => `- ${m.source} => ${m.targets.join(", ")} (${m.note})`)
    .join("\n");
  const decisions = plan.decisions.map((d) => `- ${d.topic}: ${d.choice}`).join("\n");

  return `${profile.conventions}

${stackNote ? stackNote + "\n" : ""}
## Project migration context
Summary: ${plan.summary}

Decisions:
${decisions || "- (none)"}

Route table:
${routeTable || "- (none)"}

File mapping table:
${mappingTable || "- (none)"}

Dependencies to assume: ${plan.dependencies.join(", ") || "(standard library only)"}

## Output format (STRICT)
For each source file, output the complete generated file(s):
<file path="app/page.tsx">
...complete file content...
</file>

Rules:
- One <file path="...">...</file> block per generated file; path is relative to the output project root.
- Emit COMPLETE files (no ellipses, no TODOs left inside code).
- Never wrap output in markdown fences.
- If a source file needs a shared helper, emit that helper as its own <file> block (first batch that needs it).
- Do not invent files unrelated to the provided sources, except shared helpers declared in the mapping table.`;
}

export function buildBatchUserPrompt(scan: ScanResult, rels: string[]): string {
  const byRel = new Map(scan.files.map((f) => [f.rel, f] as const));
  const parts: string[] = [
    "Convert the following legacy source file(s) to the modern target stack, following the system conventions and the project plan.",
    "For each source below, emit one or more <file path=\"...\">...</file> blocks with complete content.",
    "",
  ];
  for (const rel of rels) {
    const f = byRel.get(rel);
    if (!f?.text) continue;
    parts.push(`<source path="${rel}" language="${f.language}">\n${f.text}\n</source>`);
  }
  return parts.join("\n");
}

/** Parse all <file path="...">content</file> blocks from model output. */
export function parseGeneratedFiles(text: string): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  const re = /<file\s+path="([^"]+)"\s*>\n?([\s\S]*?)<\/file>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rel = m[1]!.trim();
    let content = m[2] ?? "";
    if (content.endsWith("\n")) content = content.slice(0, -1);
    if (rel && !rel.includes("..") && !path.isAbsolute(rel)) {
      out.push({ path: rel.replace(/\\/g, "/"), content });
    }
  }
  return out;
}
