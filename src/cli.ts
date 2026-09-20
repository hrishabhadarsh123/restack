#!/usr/bin/env node
/**
 * restack — convert legacy projects (PHP/jQuery, Python 2, Django) to modern
 * stacks (Next.js + TypeScript, FastAPI) using a frontier model's long
 * context window: Anthropic Claude, OpenAI GPT, Google Gemini, or any
 * OpenAI-compatible endpoint.
 */
import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { scanProject, buildScanJsonReport } from "./scanner.js";
import { getProfile } from "./profiles/index.js";
import { runPlanner, buildPlanJsonReport } from "./planner.js";
import {
  isInteractiveTTY,
  runPrePlanWizard,
  runPlanReviewWizard,
  runResumeWizard,
  applySelections,
  convertibleSources,
  type InteractiveOptions,
} from "./interactive.js";
import { pickTarget } from "./targets.js";
import { runConverter } from "./converter-core.js";
import { buildConversionBatches } from "./converter.js";
import { runReview } from "./review.js";
import {
  selectProvider,
  createClient,
  warnModelMismatch,
  DEFAULT_MODELS,
} from "./providers/index.js";
import type { ModelClient } from "./providers/types.js";
import {
  loadState,
  saveState,
  savePlan,
  loadPlan,
  computePlanHash,
  CostLimitError,
} from "./state.js";
import {
  REPORT_SCHEMA_VERSION,
  type ConvertEvent,
  type MigrationPlan,
  type ModernTarget,
  type ScanResult,
} from "./types.js";
import { logger } from "./util/logger.js";
import { formatCount, formatCost, formatDuration, formatPercent, formatTokens, printTable } from "./util/format.js";
import { VERSION } from "./version.js";

function resolveTarget(explicit?: string, scan?: ScanResult): ModernTarget {
  if (explicit) {
    if (explicit === "nextjs" || explicit === "fastapi") return explicit;
    logger.error(`Unknown target "${explicit}". Use "nextjs" or "fastapi".`);
    process.exit(1);
  }
  if (!scan) {
    logger.error("--target is required (nextjs | fastapi).");
    process.exit(1);
  }
  if (scan.stack === "php-jquery") return "nextjs";
  if (scan.stack === "django") return "fastapi";
  if (scan.stack === "python2") return "fastapi";
  logger.error("Could not detect the legacy stack — pass --target nextjs|fastapi explicitly.");
  process.exit(1);
}

interface CommonOpts {
  provider?: string;
  model?: string;
  verbose?: boolean;
  maxCost?: string;
}

function applyCommon(opts: CommonOpts): void {
  if (opts.verbose) logger.setLevel("debug");
}

const program = new Command();
program
  .name("restack")
  .description(
    "Convert legacy projects to modern stacks with a frontier model's 200k+ context window (Claude, GPT, Gemini)",
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description("Analyze a legacy project: detect stack, inventory files, estimate tokens/cost")
  .argument("<projectRoot>", "path to the legacy project")
  .option("--include <glob...>", "only include files matching these globs")
  .option("--exclude <glob...>", "exclude files matching these globs")
  .option("--json", "print a machine-readable JSON report on stdout (log output stays on stderr)")
  .option("--verbose", "debug logging")
  .action(async (projectRoot: string, opts: CommonOpts & { include?: string[]; exclude?: string[]; json?: boolean }) => {
    applyCommon(opts);
    let scan: ScanResult;
    try {
      scan = await scanProject(projectRoot, { includeGlobs: opts.include, excludeGlobs: opts.exclude });
    } catch (err) {
      logger.error(`Scan failed: ${(err as Error).message}`);
      process.exit(1);
    }

    if (opts.json) {
      // Machine-readable mode: report goes to stdout, human output stays on stderr,
      // so `restack scan app --json 2>/dev/null` is always valid JSON.
      process.stdout.write(JSON.stringify(buildScanJsonReport(scan), null, 2) + "\n");
      return;
    }

    const codeFiles = scan.files.filter((f) => f.text != null);
    logger.info("");
    logger.info(pc.bold(`Stack: ${scan.stack}`) + pc.dim(`  (confidence ${formatPercent(scan.confidence)})`));
    for (const ev of scan.evidence) logger.info(pc.dim(`  • ${ev}`));
    if (scan.libraries.length > 0) logger.info(pc.dim(`  libraries: ${scan.libraries.join(", ")}`));

    logger.info("");
    printTable([
      ["files scanned", String(scan.files.length)],
      ["files readable", String(codeFiles.length)],
      ["estimated tokens", formatTokens(scan.totalTokens)],
      ["context window", `${formatCount(200_000)} tokens`],
      ["fits in one window", scan.totalTokens <= 160_000 ? pc.green("yes") : pc.yellow("partially (packer will summarize)")],
    ]);

    if (scan.excludedSensitive.length > 0) {
      logger.info("");
      logger.warn(`Excluded ${scan.excludedSensitive.length} sensitive file(s): ${scan.excludedSensitive.slice(0, 8).join(", ")}${scan.excludedSensitive.length > 8 ? " …" : ""}`);
    }
    if (scan.oversizedFiles.length > 0) {
      logger.info("");
      logger.info(pc.dim(`Large files (will be summarized): ${scan.oversizedFiles.slice(0, 6).join(", ")}${scan.oversizedFiles.length > 6 ? " …" : ""}`));
    }

    logger.info("");
    logger.info(pc.dim(`Estimated planning-call input: ~${formatTokens(Math.min(scan.totalTokens, 160_000) + 4_000)} tokens ≈ ${formatCost((Math.min(scan.totalTokens + 4_000, 164_000) / 1e6) * 3 + (16_000 / 1e6) * 15)} (sonnet, one-shot plan)`));
    logger.info(pc.dim("Next: restack plan <root> --target <t>   |   restack convert <root> --target <t>"));
  });

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------
program
  .command("plan")
  .description("Generate (and save) a migration plan without converting")
  .argument("<projectRoot>", "path to the legacy project")
  .option("--target <target>", "nextjs | fastapi (auto-detected if omitted)")
  .option("--provider <id>", "anthropic | openai | google (auto-detected from env)")
  .option("--model <model>", "model id (provider default if omitted)")
  .option("--out <dir>", "where to write .restack/plan.json (defaults to ./converted)")
  .option("--max-cost <usd>", "abort if estimated spend exceeds this", "5")
  .option("--json", "print a machine-readable JSON report on stdout (log output stays on stderr)")
  .option("--interactive", "review and trim the plan interactively before it is saved (TTY required)")
  .option("--verbose", "debug logging")
  .action(async (projectRoot: string, opts: CommonOpts & { target?: string; out?: string; json?: boolean; interactive?: boolean }) => {
    applyCommon(opts);
    const interactiveRequested = opts.interactive === true;
    if (interactiveRequested && opts.json) {
      logger.error("--interactive and --json are mutually exclusive.");
      process.exit(1);
    }
    const interactive = interactiveRequested && isInteractiveTTY();
    if (interactiveRequested && !interactive) {
      logger.warn("stdout is not a TTY — falling back to non-interactive mode.");
    }
    const sel = selectProvider(opts.provider);
    if (!sel) process.exit(1);
    const model = opts.model ?? DEFAULT_MODELS[sel.id];
    warnModelMismatch(sel, model);
    const scan = await scanProject(projectRoot);
    let target: ModernTarget;
    if (interactive && opts.target === undefined) {
      const pre = await runPrePlanWizard({
        stack: scan.stack,
        suggestedTarget: scan.stack === "unknown" ? null : pickTarget(scan.stack),
        mode: "plan",
      });
      if (!pre) return;
      target = pre.target;
    } else {
      target = resolveTarget(opts.target, scan);
    }
    const outDir = path.resolve(opts.out ?? "converted");
    const maxCost = Number(opts.maxCost ?? 5);

    logger.info(`${pc.bold("restack plan")} — ${scan.stack} → ${target}`);
    logger.info(
      pc.dim(
        `Provider: ${sel.id}${sel.baseURL ? ` (via ${sel.baseURL})` : ""} · model: ${model} · max cost: ${formatCost(maxCost)}`,
      ),
    );

    const client = createClient(sel, model);
    try {
      const outcome = await runPlanner(client, scan, { target, model, maxCostUsd: maxCost });
      let plan = outcome.plan;
      let selections: InteractiveOptions | null = null;
      if (interactive) {
        selections = await runPlanReviewWizard({
          scan,
          plan,
          pricing: client.pricing,
          mode: "plan",
          usdSoFar: outcome.usd,
        });
        if (!selections) return; // wizard already printed the cancel message
        plan = applySelections(plan, selections);
      }
      await savePlan(outDir, plan);
      if (opts.json) {
        // Machine-readable mode: report on stdout, logs stay on stderr.
        const report = buildPlanJsonReport(scan, plan, {
          planHash: computePlanHash(plan, {
            root: scan.root,
            stack: scan.stack,
            files: scan.files.map((f) => ({ rel: f.rel, size: f.size })),
          }),
          usd: outcome.usd,
          calls: outcome.calls,
        });
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        return;
      }
      logger.info("");
      logger.success(`Plan saved → ${path.join(outDir, ".restack", "plan.json")}`);
      logger.info("");
      logger.info(pc.bold("Summary: ") + plan.summary);
      logger.info("");
      logger.info(pc.bold(`File mappings (${plan.fileMappings.length}):`));
      for (const m of plan.fileMappings.slice(0, 40)) {
        logger.info(`  ${pc.cyan(m.source)} → ${m.targets.join(", ")}`);
      }
      if (plan.fileMappings.length > 40) logger.info(pc.dim(`  … +${plan.fileMappings.length - 40} more`));
      if (plan.droppedFiles.length > 0) {
        logger.info("");
        logger.info(pc.bold(`Dropped (${plan.droppedFiles.length}):`));
        for (const d of plan.droppedFiles.slice(0, 10)) logger.info(pc.dim(`  ${d.path} — ${d.reason}`));
      }
      if (plan.risks.length > 0) {
        logger.info("");
        logger.info(pc.bold("Risks:"));
        for (const r of plan.risks.slice(0, 10)) logger.info(pc.yellow(`  ! ${r}`));
      }
      logger.info("");
      logger.info(pc.dim(`Cost: ${formatCost(outcome.usd)} · ${outcome.calls} call(s)`));
      logger.info(pc.dim("Next: restack convert <root> --target <t> (reuses this plan)"));
    } catch (err) {
      handleRunError(err, client);
    }
  });

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------
program
  .command("convert")
  .description("Full conversion: plan + file-by-file conversion into a new project")
  .argument("<projectRoot>", "path to the legacy project")
  .option("--target <target>", "nextjs | fastapi (auto-detected if omitted)")
  .option("--out <dir>", "output directory for the converted project", "converted")
  .option("--provider <id>", "anthropic | openai | google (auto-detected from env)")
  .option("--model <model>", "model id (provider default if omitted)")
  .option("--workers <n>", "parallel conversion batches", "2")
  .option("--max-cost <usd>", "hard spend limit in USD", "20")
  .option("--dry-run", "show the plan and exit without converting")
  .option("--json", "stream newline-delimited JSON events to stdout (logs stay on stderr)")
  .option("--interactive", "review and trim the plan interactively before converting (TTY required)")
  .option("--resume", "resume an interrupted run (reuses .restack/plan.json)")
  .option("--review", "run a final consistency review pass")
  .option("--include <glob...>", "only include files matching these globs")
  .option("--exclude <glob...>", "exclude files matching these globs")
  .option("--verbose", "debug logging")
  .action(async (projectRoot: string, opts: CommonOpts & {
    target?: string;
    out?: string;
    workers?: string;
    dryRun?: boolean;
    json?: boolean;
    interactive?: boolean;
    resume?: boolean;
    review?: boolean;
    include?: string[];
    exclude?: string[];
  }) => {
    applyCommon(opts);
    const interactiveRequested = opts.interactive === true;
    if (interactiveRequested && opts.json) {
      logger.error("--interactive and --json are mutually exclusive.");
      process.exit(1);
    }
    const interactive = interactiveRequested && isInteractiveTTY();
    if (interactiveRequested && !interactive) {
      logger.warn("stdout is not a TTY — falling back to non-interactive mode.");
    }
    const sel = selectProvider(opts.provider);
    if (!sel) process.exit(1);
    const model = opts.model ?? DEFAULT_MODELS[sel.id];
    warnModelMismatch(sel, model);
    const outDir = path.resolve(opts.out ?? "converted");
    const explicitWorkers = opts.workers !== undefined;
    const explicitMaxCost = opts.maxCost !== undefined;
    const explicitReview = opts.review !== undefined;
    let maxCost = Number(opts.maxCost ?? 20);
    let workers = Math.max(1, Math.min(8, Number(opts.workers ?? 2)));
    let review = opts.review === true;

    const scan = await scanProject(projectRoot, { includeGlobs: opts.include, excludeGlobs: opts.exclude });
    let target: ModernTarget;
    if (interactive) {
      const pre = await runPrePlanWizard({
        stack: scan.stack,
        suggestedTarget: scan.stack === "unknown" ? null : pickTarget(scan.stack),
        mode: "convert",
      });
      if (!pre) return;
      target = pre.target;
      if (!explicitWorkers && pre.workers !== undefined) workers = Math.max(1, Math.min(8, pre.workers));
      if (!explicitMaxCost && pre.maxCostUsd !== undefined) maxCost = pre.maxCostUsd;
      if (!explicitReview && pre.review !== undefined) review = pre.review;
    } else {
      target = resolveTarget(opts.target, scan);
    }
    const profile = getProfile(target);

    logger.info(`${pc.bold("restack convert")} — ${scan.stack} → ${target}`);
    logger.info(
      pc.dim(
        `Output: ${outDir} · provider: ${sel.id}${sel.baseURL ? ` (via ${sel.baseURL})` : ""} · model: ${model} · workers: ${workers} · max cost: ${formatCost(maxCost)}`,
      ),
    );

    if (scan.excludedSensitive.length > 0) {
      logger.warn(`Excluding ${scan.excludedSensitive.length} sensitive file(s) from context`);
    }

    const client = createClient(sel, model);
    const existingState = await loadState(outDir);

    // JSON event stream: the run event carries the resolved wave/batch shape
    // (planned here, re-planned below) once the conversion batches are known.
    const emit = (event: ConvertEvent): void => {
      if (!opts.json) return;
      process.stdout.write(JSON.stringify(event) + "\n");
    };
    const resuming = opts.resume === true && existingState != null;

    try {
      // ---- Plan (reused when resuming) ---------------------------------------
      let plan: MigrationPlan;
      let selections: InteractiveOptions | null = null;
      const savedPlan = resuming ? await loadPlan<MigrationPlan>(outDir) : null;
      if (savedPlan) {
        plan = savedPlan;
        logger.info(pc.dim("Reusing saved plan (.restack/plan.json)"));
        if (interactive) {
          const done = new Set(
            Object.entries(existingState!.completedSources)
              .filter(([, v]) => v.status === "converted" || v.status === "repaired")
              .map(([k]) => k),
          );
          const remaining = convertibleSources(plan).filter((s) => !done.has(s)).length;
          const choice = await runResumeWizard({ doneCount: done.size, remainingCount: remaining, outDir });
          if (!choice) return;
          if (choice === "edit") {
            selections = await runPlanReviewWizard({
              scan,
              plan,
              pricing: client.pricing,
              mode: "convert",
              usdSoFar: existingState!.usd,
            });
            if (!selections) return;
            plan = applySelections(plan, selections);
            await savePlan(outDir, plan);
          }
          // "reuse": the saved plan already IS the selected subset.
        }
      } else {
        const planned = await runPlanner(client, scan, { target, model, maxCostUsd: maxCost });
        plan = planned.plan;
        await savePlan(outDir, plan);
        logger.success(`Plan ready (${plan.fileMappings.length} mappings) — ${formatCost(planned.usd)}`);
        if (interactive) {
          selections = await runPlanReviewWizard({
            scan,
            plan,
            pricing: client.pricing,
            mode: "convert",
            usdSoFar: planned.usd,
          });
          if (!selections) return;
          plan = applySelections(plan, selections);
          await savePlan(outDir, plan);
        }
      }

      // ---- Dry run ------------------------------------------------------------
      if (opts.dryRun) {
        logger.info("");
        logger.info(pc.bold("Migration plan (dry run — nothing converted):"));
        logger.info("  " + plan.summary);
        for (const d of plan.decisions) logger.info(`  • ${d.topic}: ${d.choice}`);
        logger.info("");
        logger.info(pc.bold(`Waves: ${plan.conversionOrder.length}`));
        plan.conversionOrder.forEach((wave, i) => {
          logger.info(`  wave ${i + 1}: ${wave.join(", ")}`);
        });
        logger.info("");
        logger.info(pc.dim(`Spent so far: ${formatCost(client.usd)}`));
        logger.info(pc.dim("Run without --dry-run to convert."));
        return;
      }

      // ---- Convert --------------------------------------------------------------
      const planHash = computePlanHash(plan, {
        root: scan.root,
        stack: scan.stack,
        files: scan.files.map((f) => ({ rel: f.rel, size: f.size })),
      });
      if (existingState && existingState.planHash !== planHash && !opts.resume) {
        logger.warn("Output dir contains state from a different plan/source — pass --resume to continue it or use a fresh --out.");
      }

      const state = existingState ?? {
        version: 1 as const,
        projectRoot: scan.root,
        target,
        model,
        planHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        usd: 0,
        completedSources: {},
      };

      if (interactive && selections) {
        // Record the interactive selections so --resume reproduces the same subset.
        state.interactive = {
          excludedSources: selections.excludedSources,
          droppedRoutes: selections.droppedRoutes,
          workers: explicitWorkers ? undefined : workers,
          maxCostUsd: explicitMaxCost ? undefined : maxCost,
          review: explicitReview ? undefined : review,
        };
      }

      const startTime = Date.now();
      // Resume: skip sources already converted/repaired successfully.
      const skipSources = new Set(
        Object.entries(state.completedSources)
          .filter(([, v]) => v.status === "converted" || v.status === "repaired")
          .map(([k]) => k),
      );
      if (resuming && skipSources.size > 0) {
        logger.info(pc.dim(`Resuming: ${skipSources.size} file(s) already converted — skipping them`));
      }
      const batches = buildConversionBatches(scan, plan, skipSources);
      emit({
        schema: REPORT_SCHEMA_VERSION,
        event: "run",
        target,
        outDir,
        batches: batches.length,
        waves: plan.conversionOrder.length,
      });
      const outcome = await runConverter(client, scan, plan, outDir, {
        target,
        model,
        workers,
        maxCostUsd: maxCost,
        skipSources,
        onWave: (index) => emit({ schema: REPORT_SCHEMA_VERSION, event: "wave", index }),
        onBatchStart: (batch) => emit({ schema: REPORT_SCHEMA_VERSION, event: "batch_start", sources: batch }),
        onBatchComplete: (results) => {
          for (const r of results) {
            const mark = r.status === "failed" ? pc.red("✗") : r.status === "repaired" ? pc.yellow("🔧") : pc.green("✓");
            logger.info(`${mark} ${r.source} → ${r.outputs.map((o) => o.path).join(", ") || "(no output)"}`);
            state.completedSources[r.source] = {
              status: r.status,
              outputs: r.outputs.map((o) => o.path),
              attempts: r.attempts,
              error: r.error,
            };
          }
          emit({
            schema: REPORT_SCHEMA_VERSION,
            event: "batch_complete",
            sources: results.map((r) => r.source),
            statuses: Object.fromEntries(results.map((r) => [r.source, r.status])),
            calls: client.calls,
            usd: client.usd,
          });
          state.usd = client.usd;
          // Persist progress incrementally so an interrupted run can --resume.
          void saveState(outDir, state).catch(() => {});
        },
      });

      // ---- Optional review ---------------------------------------------------
      let reviewInfo = "";
      if (review) {
        const rev = await runReview(client, plan, outDir, { target, model, maxCostUsd: maxCost });
        reviewInfo = ` · review touched ${rev.filesTouched.length} file(s)`;
      }

      // ---- Final state ---------------------------------------------------------
      for (const r of outcome.results) {
        state.completedSources[r.source] = {
          status: r.status,
          outputs: r.outputs.map((o) => o.path),
          attempts: r.attempts,
          error: r.error,
        };
      }
      state.usd = client.usd;
      await saveState(outDir, state);

      // ---- JSON event stream ------------------------------------------------------
      for (const r of outcome.results) {
        emit({
          schema: REPORT_SCHEMA_VERSION,
          event: "file",
          source: r.source,
          status: r.status,
          outputs: r.outputs.map((o) => o.path),
          attempts: r.attempts,
          error: r.error,
        });
      }
      emit({
        schema: REPORT_SCHEMA_VERSION,
        event: "summary",
        stats: {
          filesConverted: outcome.stats.filesConverted,
          filesRepaired: outcome.stats.filesRepaired,
          filesFailed: outcome.stats.filesFailed,
          filesDropped: outcome.stats.filesDropped,
          calls: outcome.stats.calls,
          usd: outcome.stats.usd,
          durationMs: outcome.stats.durationMs,
        },
      });

      // ---- Report ----------------------------------------------------------------
      const dur = Date.now() - startTime;
      logger.info("");
      logger.success(pc.bold(`Conversion finished in ${formatDuration(dur)}${reviewInfo}`));
      printTable([
        ["converted", pc.green(String(outcome.stats.filesConverted))],
        ["repaired", pc.yellow(String(outcome.stats.filesRepaired))],
        ["failed", outcome.stats.filesFailed > 0 ? pc.red(String(outcome.stats.filesFailed)) : "0"],
        ["dropped (by plan)", String(outcome.stats.filesDropped)],
        ["API calls", String(outcome.stats.calls + (client.calls - outcome.stats.calls))],
        ["total spend", formatCost(client.usd)],
      ]);

      logger.info("");
      logger.info(pc.bold("Run it: ") + profile.runInstructions.replace("<outDir>", outDir));
      logger.info(pc.dim(`State: ${path.join(outDir, ".restack", "state.json")} (resume with --resume)`));
      if (outcome.stats.filesFailed > 0) {
        logger.info("");
        logger.warn("Some files failed verification — inspect the errors above, fix inputs, then re-run with --resume.");
      }
    } catch (err) {
      handleRunError(err, client);
    }
  });

function handleRunError(err: unknown, client?: ModelClient): never {
  if (err instanceof CostLimitError) {
    logger.error(err.message);
    if (client) logger.info(pc.dim(`Spent so far: ${formatCost(client.usd)}`));
  } else {
    logger.error((err as Error).message);
    if (logger.getLevel() === "debug") {
      logger.debug((err as Error).stack ?? "");
    }
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------
program
  .command("mcp")
  .description("Run the restack MCP server on stdio (Antigravity, Hermes Agent, Claude Code, Cursor, ...)")
  .option("--verbose", "debug logging")
  .action(async (opts: CommonOpts) => {
    applyCommon(opts);
    // Lazy import: keep CLI startup fast for the regular commands.
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message);
  process.exit(1);
});
