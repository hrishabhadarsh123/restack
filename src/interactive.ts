/**
 * Interactive convert/plan mode (`restack convert --interactive`).
 *
 * Two layers:
 *  - Pure, testable helpers: `InteractiveOptions` (the recorded selections),
 *    `applySelections` (trims a plan to the selected subset) and
 *    `estimateConversionCostUsd` (subset cost preview).
 *  - TTY-only wizards built on @clack/prompts. Every entry point is guarded by
 *    `isInteractiveTTY()`; callers fall back to the plain non-interactive flow
 *    when it is false, so CI/automation is never left hanging on a prompt.
 *
 * Selections are persisted in `.restack/state.json` (`interactive` field) and
 * the trimmed plan itself is saved, so `--resume` reproduces the same subset.
 */
import * as p from "@clack/prompts";
import { buildConversionBatches } from "./converter.js";
import type { MigrationPlan, ModernTarget, ScanResult } from "./types.js";
import type { ModelPricing } from "./util/tokens.js";
import { formatCost, formatTokens } from "./util/format.js";

// ---------------------------------------------------------------------------
// Pure helpers (no TTY involved)
// ---------------------------------------------------------------------------

/** Interactive selections, recorded in `.restack/state.json`. */
export interface InteractiveOptions {
  /** Sources the user removed from the plan. */
  excludedSources: string[];
  /** Route mappings (by `from`) the user dropped. */
  droppedRoutes: string[];
  workers?: number;
  maxCostUsd?: number;
  review?: boolean;
}

/** True only when both stdin and stdout are terminals. */
export function isInteractiveTTY(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/** Sources the plan will actually generate output for (≥1 target path). */
export function convertibleSources(plan: MigrationPlan): string[] {
  return plan.fileMappings.filter((m) => m.targets.length > 0).map((m) => m.source);
}

/** Trim a plan down to the interactively selected subset. */
export function applySelections(plan: MigrationPlan, opts: InteractiveOptions): MigrationPlan {
  const excluded = new Set(opts.excludedSources);
  const dropped = new Set(opts.droppedRoutes);
  return {
    ...plan,
    fileMappings: plan.fileMappings.filter((m) => !excluded.has(m.source)),
    conversionOrder: plan.conversionOrder
      .map((wave) => wave.filter((s) => !excluded.has(s)))
      .filter((wave) => wave.length > 0),
    routeMappings: plan.routeMappings.filter((r) => !dropped.has(r.from)),
  };
}

const BATCH_OVERHEAD_TOKENS = 6_000; // system prompt + plan tables, per batch
const BATCH_OUTPUT_TOKENS = 24_000; // matches the converter's OUTPUT_RESERVE

/**
 * Rough conversion cost for the selected subset. Deliberately conservative:
 * no cache discounts, full output reserve per batch.
 */
export function estimateConversionCostUsd(
  scan: ScanResult,
  plan: MigrationPlan,
  pricing: ModelPricing,
): { usd: number; batches: number; inputTokens: number; outputTokens: number } {
  const batches = buildConversionBatches(scan, plan);
  const byRel = new Map(scan.files.map((f) => [f.rel, f] as const));
  let inputTokens = 0;
  let outputTokens = 0;
  for (const batch of batches) {
    const batchTokens = batch.reduce((sum, rel) => sum + (byRel.get(rel)?.tokens ?? 0), 0);
    inputTokens += batchTokens + BATCH_OVERHEAD_TOKENS;
    outputTokens += BATCH_OUTPUT_TOKENS;
  }
  const usd =
    (inputTokens / 1e6) * pricing.inputPerMillion + (outputTokens / 1e6) * pricing.outputPerMillion;
  return { usd, batches: batches.length, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// TTY wizards (@clack/prompts)
// ---------------------------------------------------------------------------

class Cancelled extends Error {}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Cancelled();
  return value as T;
}

/** Run `body`, mapping a user cancel to `null` (caller exits cleanly). */
async function withCancel(
  body: () => Promise<string | boolean | null>,
): Promise<string | boolean | null> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof Cancelled) {
      p.cancel("Aborted — nothing was saved.");
      return null;
    }
    throw err;
  }
}

export interface PrePlanResult {
  target: ModernTarget;
  workers?: number;
  maxCostUsd?: number;
  review?: boolean;
}

/**
 * Pre-planning prompts. `plan` mode only asks for the target (call sites skip
 * the wizard entirely when --target was passed explicitly); `convert` mode
 * also asks for workers, spend limit and the review pass.
 */
export async function runPrePlanWizard(opts: {
  stack: string;
  suggestedTarget: ModernTarget | null;
  mode: "plan" | "convert";
}): Promise<PrePlanResult | null> {
  p.intro(`restack ${opts.mode} — interactive setup`);
  const result = await withCancel(async () => {
    const target = unwrap(
      await p.select<ModernTarget>({
        message: `Detected stack: ${opts.stack}. Convert to which target?`,
        initialValue: opts.suggestedTarget ?? undefined,
        options: [
          { value: "nextjs", label: "Next.js (App Router) + TypeScript strict" },
          { value: "fastapi", label: "FastAPI + Pydantic v2 + SQLAlchemy 2.0" },
        ],
      }),
    );
    const res: PrePlanResult = { target: target as ModernTarget };
    if (opts.mode === "convert") {
      const workersText = unwrap(
        await p.text({
          message: "Parallel conversion batches (1–8)",
          initialValue: "2",
          validate: (v) =>
            Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 8
              ? undefined
              : "Enter an integer between 1 and 8",
        }),
      );
      res.workers = Number(workersText);
      const maxCostText = unwrap(
        await p.text({
          message: "Hard spend limit in USD",
          initialValue: "20",
          validate: (v) => (Number(v) > 0 ? undefined : "Enter an amount greater than 0"),
        }),
      );
      res.maxCostUsd = Number(maxCostText);
      res.review = (unwrap(
        await p.confirm({
          message: "Run a final cross-file review pass after conversion?",
          initialValue: false,
        }),
      )) as boolean;
    }
    return JSON.stringify(res);
  });
  if (result === null) return null;
  p.outro("Planning…");
  return JSON.parse(result as string) as PrePlanResult;
}

/**
 * Post-planning review: toggle per-file inclusion, confirm/trim routes, show
 * the subset cost estimate and confirm before anything expensive happens.
 */
export async function runPlanReviewWizard(opts: {
  scan: ScanResult;
  plan: MigrationPlan;
  pricing: ModelPricing;
  mode: "plan" | "convert";
  usdSoFar: number;
}): Promise<InteractiveOptions | null> {
  p.intro(`restack ${opts.mode} — review the plan`);
  const result = await withCancel(async () => {
    const plan = opts.plan;
    p.note(
      [
        `Summary: ${plan.summary}`,
        `Decisions: ${plan.decisions.map((d) => d.topic).join(", ") || "none"}`,
        `Waves: ${plan.conversionOrder.length} · Routes: ${plan.routeMappings.length} · Dependencies: ${plan.dependencies.length}`,
        plan.risks.length > 0 ? `Risks: ${plan.risks.slice(0, 3).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "Plan overview",
    );

    // 1) File mappings — toggle inclusion per file.
    const mappingOptions = plan.fileMappings.map((m) => ({
      value: m.source,
      label: m.source,
      hint: m.targets.length > 0 ? `→ ${m.targets.join(", ")}` : m.note,
    }));
    const selected = unwrap(
      await p.multiselect({
        message: "Files to convert (space toggles, enter confirms)",
        options: mappingOptions,
        initialValues: mappingOptions.map((o) => o.value),
        required: false,
      }),
    ) as string[];
    const excludedSources = mappingOptions.map((o) => o.value).filter((s) => !selected.includes(s));

    // 2) Route mappings — confirm all, or trim.
    let droppedRoutes: string[] = [];
    if (plan.routeMappings.length > 0) {
      const routesOk = unwrap(
        await p.confirm({
          message: `Keep all ${plan.routeMappings.length} route mappings?`,
          initialValue: true,
        }),
      );
      if (!routesOk) {
        const kept = unwrap(
          await p.multiselect({
            message: "Routes to keep",
            options: plan.routeMappings.map((r) => ({
              value: r.from,
              label: (r.method ? `${r.method} ` : "") + r.from,
              hint: `→ ${r.to}`,
            })),
            initialValues: plan.routeMappings.map((r) => r.from),
            required: false,
          }),
        ) as string[];
        droppedRoutes = plan.routeMappings.map((r) => r.from).filter((f) => !kept.includes(f));
      }
    }

    // 3) Subset cost preview.
    const working = applySelections(plan, { excludedSources, droppedRoutes });
    if (convertibleSources(working).length === 0) {
      p.log.warn("No files selected — nothing would be converted.");
      p.cancel("Aborted — nothing was saved.");
      return null;
    }
    const est = estimateConversionCostUsd(opts.scan, working, opts.pricing);
    p.note(
      [
        `Files: ${convertibleSources(working).length} of ${plan.fileMappings.length} · ${est.batches} batch(es)`,
        `Estimated tokens: ~${formatTokens(est.inputTokens)} in / ~${formatTokens(est.outputTokens)} out`,
        `Estimated conversion cost: ~${formatCost(est.usd)}${
          opts.usdSoFar > 0 ? ` · spent so far ${formatCost(opts.usdSoFar)}` : ""
        }`,
        "Heuristic estimate — excludes cache discounts.",
      ].join("\n"),
      "Selected subset",
    );

    // 4) Final confirm.
    const go = unwrap(
      await p.confirm({
        message: opts.mode === "convert" ? "Start conversion with this subset?" : "Save this trimmed plan?",
        initialValue: true,
      }),
    );
    if (!go) {
      p.cancel("Aborted — nothing was saved.");
      return null;
    }
    return JSON.stringify({ excludedSources, droppedRoutes });
  });
  if (result === null || typeof result !== "string") return null;
  p.outro(opts.mode === "convert" ? "Converting…" : "Plan saved.");
  return JSON.parse(result) as InteractiveOptions;
}

export type ResumeChoice = "reuse" | "edit";

/** Resume prompt: reuse the recorded selections or re-edit the subset. */
export async function runResumeWizard(opts: {
  doneCount: number;
  remainingCount: number;
  outDir: string;
}): Promise<ResumeChoice | null> {
  p.intro("restack convert — resume");
  const result = await withCancel(async () => {
    p.note(
      [
        `${opts.doneCount} file(s) already converted · ${opts.remainingCount} remaining`,
        `State: ${opts.outDir}/.restack`,
      ].join("\n"),
      "Previous run found",
    );
    const choice = (unwrap(
      await p.select<ResumeChoice>({
        message: "Reuse the previous interactive selections or re-edit them?",
        initialValue: "reuse",
        options: [
          { value: "reuse", label: "Reuse previous selections" },
          { value: "edit", label: "Re-edit file/route selections" },
        ],
      }),
    )) as ResumeChoice;
    return choice;
  });
  if (result === null) return null;
  p.outro(result === "reuse" ? "Resuming with previous selections…" : "Editing selections…");
  return result as ResumeChoice;
}
