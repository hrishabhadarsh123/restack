/**
 * Optional review pass (pass 3): feeds the converted project's files to
 * Claude to fix cross-file inconsistencies after conversion.
 */
import { promises as fsp } from "node:fs";
import type { AnthropicClient } from "./anthropic.js";
import { getProfile } from "./profiles/index.js";
import type { MigrationPlan, ModernTarget } from "./types.js";
import { logger } from "./util/logger.js";
import { estimateTokens } from "./util/tokens.js";
import { walkDirectory } from "./util/fs.js";
import { CostLimitError } from "./state.js";
import { writeGeneratedFiles } from "./converter-core.js";
import { parseGeneratedFiles } from "./converter.js";

const REVIEW_OUTPUT_RESERVE = 16_000;

export interface ReviewOptions {
  target: ModernTarget;
  model: string;
  maxCostUsd?: number;
}

export interface ReviewOutcome {
  filesTouched: string[];
  calls: number;
  usd: number;
}

async function loadConvertedFiles(outDir: string): Promise<Array<{ rel: string; text: string }>> {
  const walked = await walkDirectory(outDir, {
    includeExts: [".ts", ".tsx", ".py", ".css", ".json", ".md"],
    skipDirs: ["node_modules", ".venv", "venv", "__pycache__", ".next", ".restack"],
  });
  const out: Array<{ rel: string; text: string }> = [];
  for (const f of walked) {
    if (f.size > 256 * 1024) continue;
    try {
      const text = await fsp.readFile(f.abs, "utf8");
      out.push({ rel: f.rel, text });
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

export async function runReview(
  client: AnthropicClient,
  plan: MigrationPlan,
  outDir: string,
  opts: ReviewOptions,
): Promise<ReviewOutcome> {
  const profile = getProfile(opts.target);
  const files = await loadConvertedFiles(outDir);
  if (files.length === 0) {
    logger.warn("Review: no converted files found — skipping");
    return { filesTouched: [], calls: 0, usd: 0 };
  }

  const filesBlock = files.map((f) => `<file path="${f.rel}">\n${f.text}\n</file>`).join("\n");

  const system = [
    `You are reviewing a freshly converted ${profile.label} project for cross-file consistency.`,
    "",
    "The migration plan was:",
    JSON.stringify(
      {
        summary: plan.summary,
        decisions: plan.decisions,
        routeMappings: plan.routeMappings.slice(0, 40),
        dependencies: plan.dependencies,
      },
      null,
      2,
    ),
    "",
    "Fix REAL bugs and inconsistencies only: mismatched imports/exports, route paths",
    "that differ from the route table, references to missing files, or type errors.",
    "Do NOT restyle or rewrite working code. Keep behavior identical.",
    "",
    'When you change a file, re-emit it fully in a <file path="...">...</file> block.',
    "If nothing needs fixing, output exactly: NO_CHANGES",
  ].join("\n");

  const user = "Converted project files:\n\n" + filesBlock + "\n\nReview and fix real inconsistencies. If nothing needs fixing, output NO_CHANGES.";

  const inEst = estimateTokens(system) + estimateTokens(user);
  const estCost =
    (inEst / 1e6) * client.pricing.inputPerMillion +
    (REVIEW_OUTPUT_RESERVE / 1e6) * client.pricing.outputPerMillion;
  if (opts.maxCostUsd != null && client.usd + estCost > opts.maxCostUsd) {
    throw new CostLimitError(client.usd + estCost, opts.maxCostUsd);
  }

  const res = await client.call({
    model: opts.model,
    maxTokens: REVIEW_OUTPUT_RESERVE,
    system,
    messages: [{ role: "user", content: user }],
    cacheLastUserBlock: true,
    temperature: 0,
    label: "review",
  });

  if (res.text.includes("NO_CHANGES") && !res.text.includes("<file")) {
    logger.success("Review: no changes needed");
    return { filesTouched: [], calls: 1, usd: res.costUsd };
  }

  const outputs = parseGeneratedFiles(res.text);
  await writeGeneratedFiles(outDir, outputs);
  logger.success(`Review: updated ${outputs.length} file(s)`);
  return { filesTouched: outputs.map((o) => o.path), calls: 1, usd: res.costUsd };
}
