#!/usr/bin/env node
/**
 * restack — convert legacy projects (PHP/jQuery, Python 2) to modern stacks
 * (Next.js + TypeScript, FastAPI) using Claude's long context window.
 */
import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import { scanProject } from "./scanner.js";
import { getProfile } from "./profiles/index.js";
import { runPlanner } from "./planner.js";
import { runConverter } from "./converter-core.js";
import { runReview } from "./review.js";
import { AnthropicClient } from "./anthropic.js";
import {
  loadState,
  saveState,
  savePlan,
  loadPlan,
  computePlanHash,
  CostLimitError,
} from "./state.js";
import type { MigrationPlan, ModernTarget, ScanResult } from "./types.js";
import { logger } from "./util/logger.js";
import { formatCount, formatCost, formatDuration, formatPercent, formatTokens, printTable } from "./util/format.js";

const VERSION = "0.1.0";

function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    logger.error("ANTHROPIC_API_KEY environment variable is not set.");
    logger.info("Get a key at https://console.anthropic.com/ and run:");
    logger.info("  export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }
  return key;
}

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
  if (scan.stack === "python2") return "fastapi";
  logger.error("Could not detect the legacy stack — pass --target nextjs|fastapi explicitly.");
  process.exit(1);
}

interface CommonOpts {
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
  .description("Convert legacy projects to modern stacks with Claude's 200k context window")
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
  .option("--verbose", "debug logging")
  .action(async (projectRoot: string, opts: CommonOpts & { include?: string[]; exclude?: string[] }) => {
    applyCommon(opts);
    let scan: ScanResult;
    try {
      scan = await scanProject(projectRoot, { includeGlobs: opts.include, excludeGlobs: opts.exclude });
    } catch (err) {
      logger.error(`Scan failed: ${(err as Error).message}`);
      process.exit(1);
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
  .option("--model <model>", "Claude model id", "claude-sonnet-4-5")
  .option("--out <dir>", "where to write .restack/plan.json (defaults to ./converted)")
  .option("--max-cost <usd>", "abort if estimated spend exceeds this", "5")
  .option("--verbose", "debug logging")
  .action(async (projectRoot: string, opts: CommonOpts & { target?: string; out?: string }) => {
    applyCommon(opts);
    const apiKey = requireApiKey();
    const scan = await scanProject(projectRoot);
    const target = resolveTarget(opts.target, scan);
    const outDir = path.resolve(opts.out ?? "converted");
    const maxCost = Number(opts.maxCost ?? 5);

    logger.info(`${pc.bold("restack plan")} — ${scan.stack} → ${target}`);
    logger.info(pc.dim(`Model: ${opts.model ?? "claude-sonnet-4-5"} · max cost: ${formatCost(maxCost)}`));

    const client = new AnthropicClient(apiKey, opts.model ?? "claude-sonnet-4-5");
    try {
      const outcome = await runPlanner(client, scan, { target, model: opts.model ?? "claude-sonnet-4-5", maxCostUsd: maxCost });
      await savePlan(outDir, outcome.plan);
      const plan = outcome.plan;
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
  .option("--model <model>", "Claude model id", "claude-sonnet-4-5")
  .option("--workers <n>", "parallel conversion batches", "2")
  .option("--max-cost <usd>", "hard spend limit in USD", "20")
  .option("--dry-run", "show the plan and exit without converting")
  .option("--resume", "resume an interrupted run (reuses .restack/plan.json)")
  .option("--review", "run a final consistency review pass", false)
  .option("--include <glob...>", "only include files matching these globs")
  .option("--exclude <glob...>", "exclude files matching these globs")
  .option("--verbose", "debug logging")
  .action(async (projectRoot: string, opts: CommonOpts & {
    target?: string;
    out?: string;
    workers?: string;
    dryRun?: boolean;
    resume?: boolean;
    review?: boolean;
    include?: string[];
    exclude?: string[];
  }) => {
    applyCommon(opts);
    const model = opts.model ?? "claude-sonnet-4-5";
    const outDir = path.resolve(opts.out ?? "converted");
    const maxCost = Number(opts.maxCost ?? 20);
    const workers = Math.max(1, Math.min(8, Number(opts.workers ?? 2)));

    const scan = await scanProject(projectRoot, { includeGlobs: opts.include, excludeGlobs: opts.exclude });
    const target = resolveTarget(opts.target, scan);
    const profile = getProfile(target);

    logger.info(`${pc.bold("restack convert")} — ${scan.stack} → ${target}`);
    logger.info(pc.dim(`Output: ${outDir} · model: ${model} · workers: ${workers} · max cost: ${formatCost(maxCost)}`));

    if (scan.excludedSensitive.length > 0) {
      logger.warn(`Excluding ${scan.excludedSensitive.length} sensitive file(s) from context`);
    }

    const apiKey = requireApiKey();
    const client = new AnthropicClient(apiKey, model);
    const existingState = await loadState(outDir);
    const resuming = opts.resume === true && existingState != null;

    try {
      // ---- Plan (reused when resuming) ---------------------------------------
      let plan: MigrationPlan;
      const savedPlan = resuming ? await loadPlan<MigrationPlan>(outDir) : null;
      if (savedPlan) {
        plan = savedPlan;
        logger.info(pc.dim("Reusing saved plan (.restack/plan.json)"));
      } else {
        const planned = await runPlanner(client, scan, { target, model, maxCostUsd: maxCost });
        plan = planned.plan;
        await savePlan(outDir, plan);
        logger.success(`Plan ready (${plan.fileMappings.length} mappings) — ${formatCost(planned.usd)}`);
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
      const outcome = await runConverter(client, scan, plan, outDir, {
        target,
        model,
        workers,
        maxCostUsd: maxCost,
        skipSources,
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
          state.usd = client.usd;
          // Persist progress incrementally so an interrupted run can --resume.
          void saveState(outDir, state).catch(() => {});
        },
      });

      // ---- Optional review ---------------------------------------------------
      let reviewInfo = "";
      if (opts.review) {
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

function handleRunError(err: unknown, client?: AnthropicClient): never {
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

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message);
  process.exit(1);
});
