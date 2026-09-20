/**
 * Planner (pass 1): packs the whole project into one big Claude call and gets
 * back a structured MigrationPlan (validated with zod).
 */
import type { AnthropicClient } from "./anthropic.js";
import { packContext } from "./packer.js";
import { getProfile } from "./profiles/index.js";
import {
  MigrationPlanSchema,
  REPORT_SCHEMA_VERSION,
  type MigrationPlan,
  type ModernTarget,
  type PlanJsonReport,
  type ScanResult,
} from "./types.js";
import { logger } from "./util/logger.js";
import { formatTokens } from "./util/format.js";
import { estimateTokens } from "./util/tokens.js";

/** Reserved room for the plan JSON output + prompt scaffolding. */
const OUTPUT_RESERVE = 16_000;
const SCAFFOLD_TOKENS = 3_000;

export interface PlanOptions {
  target: ModernTarget;
  model: string;
  maxCostUsd?: number;
}

export interface PlanOutcome {
  plan: MigrationPlan;
  packed: ReturnType<typeof packContext>;
  calls: number;
  usd: number;
}

export function buildPlanningPrompt(scan: ScanResult, target: ModernTarget): string {
  const profile = getProfile(target);
  return `You are a principal software architect planning a migration from a legacy codebase to ${profile.label}.

Below is a captured snapshot of a legacy project: an inventory of every file, followed by the source of as many files as fit.

Your job: produce a complete, unambiguous migration plan for this exact project — not generic advice. Every legacy file must appear in exactly one of: fileMappings (converted), droppedFiles (intentionally dropped), or scaffoldFiles is for brand-new files only.

Rules:
- fileMappings.source must be the exact rel path from the inventory.
- targets must be new-file rel paths for the ${target} project.
- conversionOrder: group source paths into waves. Wave 1 = shared foundations (db, config, shared utilities). Later waves depend on earlier ones. Every converted source must appear in exactly one wave.
- routeMappings: list every legacy URL/entrypoint and its modern route.
- decisions: record real choices for THIS project (e.g. "session auth via cookie", "jQuery tables -> server-rendered tables + one client component").
- dependencies: exact package names for the new project (npm or pip), versions optional.
- risks: project-specific gotchas the converter must not get wrong.

Respond with ONLY a JSON object matching this TypeScript type (no markdown fences, no commentary):

interface MigrationPlan {
  target: "nextjs" | "fastapi";
  summary: string;
  decisions: { topic: string; choice: string }[];
  dependencies: string[];
  fileMappings: { source: string; targets: string[]; note: string }[];
  routeMappings: { from: string; to: string; method?: string }[];
  droppedFiles: { path: string; reason: string }[];
  scaffoldFiles: { path: string; purpose: string }[];
  conversionOrder: string[][];
  risks: string[];
}`;
}

export async function runPlanner(
  client: AnthropicClient,
  scan: ScanResult,
  opts: PlanOptions,
): Promise<PlanOutcome> {
  const profile = getProfile(opts.target);
  const budget = client.pricing.contextWindow - OUTPUT_RESERVE - SCAFFOLD_TOKENS;
  const packed = packContext(scan, { tokenBudget: budget });

  const system = `${profile.conventions}\n\nYou plan migrations precisely and output only valid JSON.`;
  const user = buildPlanningPrompt(scan, opts.target) + "\n\n" + packed.text;

  const inTokens = estimateTokens(system) + estimateTokens(user);
  logger.info(`Planning call: ~${formatTokens(inTokens)} input, ${packed.verbatim.length} files verbatim, ${packed.summarized.length} summarized, ${packed.omitted.length} omitted`);

  const res = await client.call({
    model: opts.model,
    maxTokens: OUTPUT_RESERVE,
    system,
    messages: [{ role: "user", content: user }],
    cacheLastUserBlock: false,
    temperature: 0,
    label: "plan",
  });

  const plan = parsePlan(res.text, opts.target);
  return { plan, packed, calls: 1, usd: res.costUsd };
}

/**
 * Machine-readable form of a planning run (emitted by `restack plan --json`).
 * Pure function so it can be unit-tested without running the CLI.
 */
export function buildPlanJsonReport(
  scan: ScanResult,
  plan: MigrationPlan,
  meta: { planHash?: string; usd?: number; calls?: number },
): PlanJsonReport {
  return {
    schema: REPORT_SCHEMA_VERSION,
    root: scan.root,
    target: plan.target,
    stack: scan.stack,
    planHash: meta.planHash,
    summary: plan.summary,
    decisions: plan.decisions,
    dependencies: plan.dependencies,
    fileMappings: plan.fileMappings,
    routeMappings: plan.routeMappings,
    droppedFiles: plan.droppedFiles,
    waves: plan.conversionOrder,
    risks: plan.risks,
    estimatedCostUsd: meta.usd,
    calls: meta.calls,
  };
}

/** Parse + validate the plan JSON, tolerating markdown fences and stray text. */
export function parsePlan(text: string, target: ModernTarget): MigrationPlan {
  let raw = text.trim();
  // Strip markdown fences if present
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1]!.trim();
  // Otherwise take the outermost JSON object
  if (!raw.startsWith("{")) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Planner returned no JSON object");
    }
    raw = raw.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Planner JSON parse failed: " + (err as Error).message);
  }

  const validated = MigrationPlanSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error("Planner output failed validation: " + issues);
  }

  const plan = validated.data;
  if (plan.target !== target) {
    logger.warn(`Planner returned target=${plan.target}, overriding to ${target}`);
    plan.target = target;
  }
  return plan;
}
