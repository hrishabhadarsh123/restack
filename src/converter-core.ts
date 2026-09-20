/**
 * Converter core: runConverter orchestrates batches, writes scaffold,
 * verifies the generated project and runs a bounded repair loop.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { ModelClient } from "./providers/types.js";
import { getProfile } from "./profiles/index.js";
import type { ConvertStats, FileResult, GeneratedFile, MigrationPlan, ModernTarget, ScanResult } from "./types.js";
import { logger } from "./util/logger.js";
import { estimateTokens } from "./util/tokens.js";
import { CostLimitError } from "./state.js";
import {
  buildConversionBatches,
  buildConversionSystemPrompt,
  buildBatchUserPrompt,
  parseGeneratedFiles,
} from "./converter.js";

const OUTPUT_RESERVE = 24_000;

export interface ConvertOptions {
  target: ModernTarget;
  model: string;
  workers: number;
  maxCostUsd?: number;
  maxRepairRounds?: number;
  onBatchComplete?: (results: FileResult[]) => void;
  /** Fired when processing reaches a new wave (convert --json event stream). */
  onWave?: (index: number) => void;
  /** Fired immediately before a batch is picked up. */
  onBatchStart?: (batch: string[]) => void;
  /** Resume support: sources already converted successfully (skipped). */
  skipSources?: Set<string>;
  /** Test hook: override profile verification. */
  verifyOverride?: (ctx: { outDir: string }) => Promise<{ ok: boolean; errors: string[] }>;
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
    durationMs: number;
  };
}

export async function writeGeneratedFiles(outDir: string, outputs: GeneratedFile[]): Promise<void> {
  for (const o of outputs) {
    const abs = path.join(outDir, o.path.split("/").join(path.sep));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, o.content, "utf8");
  }
}

interface BatchStats {
  calls: number;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the full conversion pass. Batches are processed with bounded
 * concurrency; each batch is verified and repaired up to maxRepairRounds.
 */
export async function runConverter(
  client: ModelClient,
  scan: ScanResult,
  plan: MigrationPlan,
  outDir: string,
  opts: ConvertOptions,
): Promise<ConvertOutcome> {
  const profile = getProfile(opts.target);
  const verifyFn = opts.verifyOverride ?? ((ctx: { outDir: string }) => profile.verify(ctx));
  const maxRepair = opts.maxRepairRounds ?? 1;
  const startedAt = Date.now();

  // ---- Static scaffold ------------------------------------------------------
  const scaffoldWritten: string[] = [];
  for (const s of profile.staticScaffold ?? []) {
    const abs = path.join(outDir, s.path.split("/").join(path.sep));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, s.content, "utf8");
    scaffoldWritten.push(s.path);
  }
  for (const s of plan.scaffoldFiles) {
    const abs = path.join(outDir, s.path.split("/").join(path.sep));
    if (!(await fileExists(abs))) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, `# ${s.purpose}\n`, "utf8");
      scaffoldWritten.push(s.path);
    }
  }

  // ---- Batches --------------------------------------------------------------
  const batches = buildConversionBatches(scan, plan, opts.skipSources);
  logger.info(
    `Conversion: ${batches.length} batch(es) across ${plan.conversionOrder.length} wave(s), ${opts.workers} worker(s)`,
  );

  const system = buildConversionSystemPrompt(plan, opts.target, scan.stack);
  const results: FileResult[] = [];
  let completedBatches = 0;
  const batchStats: BatchStats = { calls: 0 };

  async function convertBatch(batch: string[]): Promise<FileResult[]> {
    const user = buildBatchUserPrompt(scan, batch);
    const inEst = estimateTokens(system) + estimateTokens(user);
    const expectedOut = Math.min(
      OUTPUT_RESERVE,
      Math.ceil(scan.files.filter((f) => batch.includes(f.rel)).reduce((s, f) => s + f.tokens, 0) * 1.6) + 500,
    );
    const estCost =
      (inEst / 1e6) * client.pricing.inputPerMillion +
      (expectedOut / 1e6) * client.pricing.outputPerMillion;
    if (opts.maxCostUsd != null && client.usd + estCost > opts.maxCostUsd) {
      throw new CostLimitError(client.usd + estCost, opts.maxCostUsd);
    }

    const res = await client.call({
      model: opts.model,
      maxTokens: OUTPUT_RESERVE,
      system,
      messages: [{ role: "user", content: user }],
      cacheLastUserBlock: true,
      temperature: 0,
      label: `convert ${batch.join(",")}`.slice(0, 60),
    });
    batchStats.calls += 1;

    let outputs = parseGeneratedFiles(res.text);
    let status: FileResult["status"] = "converted";
    let error: string | undefined;
    let rounds = 0;

    // ---- Verification + repair ---------------------------------------------
    await writeGeneratedFiles(outDir, outputs);
    let verify = await verifyFn({ outDir });
    if (!verify.ok) {
      for (let round = 0; round < maxRepair; round++) {
        rounds++;
        logger.warn(
          `Verification failed (${verify.errors.length} error(s)) — repair round ${round}/${maxRepair} for batch [${batch.join(", ")}]`,
        );
        const repairRes = await client.call({
          model: opts.model,
          maxTokens: OUTPUT_RESERVE,
          system,
          messages: [
            { role: "user", content: user },
            { role: "assistant", content: res.text },
            {
              role: "user",
              content:
                `Verification failed with these errors:\n${verify.errors.slice(0, 20).join("\n")}\n\n` +
                `Re-emit ONLY the <file> blocks that need changes (complete files, same output format).`,
            },
          ],
          cacheLastUserBlock: true,
          temperature: 0,
          label: `repair ${batch.join(",")}`.slice(0, 60),
        });
        batchStats.calls += 1;
        const repairOutputs = parseGeneratedFiles(repairRes.text);
        const merged = new Map(outputs.map((o) => [o.path, o] as const));
        for (const ro of repairOutputs) merged.set(ro.path, ro);
        outputs = [...merged.values()];
        await writeGeneratedFiles(outDir, outputs);
        verify = await verifyFn({ outDir });
        if (verify.ok) {
          status = "repaired";
          error = undefined;
          break;
        }
      }
      if (!verify.ok) {
        status = "failed";
        error = verify.errors.slice(0, 5).join("\n");
        logger.error(`Batch [${batch.join(", ")}] still failing after repair: ${error.slice(0, 200)}`);
      }
    }

    // Attribute outputs to sources (heuristic: path basename overlap).
    return batch.map((rel) => ({
      source: rel,
      outputs: attributeOutputs(outputs, rel),
      status,
      attempts: 1 + rounds,
      error,
    }));
  }

  // ---- Bounded-concurrency batch processor ---------------------------------
  const queue = [...batches];

  // Wave index per batch (first wave containing the batch's first source).
  const waveIndexFor = (batch: string[]): number => {
    const first = batch[0];
    if (!first) return 0;
    for (let i = 0; i < plan.conversionOrder.length; i++) {
      if (plan.conversionOrder[i]!.includes(first)) return i;
    }
    return plan.conversionOrder.length;
  };
  let lastWave = -1;

  async function worker(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (opts.maxCostUsd != null && client.usd >= opts.maxCostUsd) {
        throw new CostLimitError(client.usd, opts.maxCostUsd);
      }
      const batch = queue.shift();
      if (!batch) break;
      const waveIdx = waveIndexFor(batch);
      if (waveIdx !== lastWave) {
        lastWave = waveIdx;
        opts.onWave?.(waveIdx);
      }
      opts.onBatchStart?.(batch);
      let batchResults: FileResult[];
      try {
        batchResults = await convertBatch(batch);
      } catch (err) {
        if (err instanceof CostLimitError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Batch [${batch.join(", ")}] failed: ${msg}`);
        batchResults = batch.map((rel) => ({
          source: rel,
          outputs: [],
          status: "failed" as const,
          attempts: 1,
          error: msg,
        }));
      }
      results.push(...batchResults);
      completedBatches++;
      logger.debug(`Batch ${completedBatches} done: [${batch.join(", ")}]`);
      opts.onBatchComplete?.(batchResults);
    }
  }

  const nWorkers = Math.max(1, Math.min(opts.workers, batches.length || 1));
  const workerPromises = Array.from({ length: nWorkers }, () => worker());
  const settled = await Promise.allSettled(workerPromises);
  const firstRejection = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (firstRejection) {
    throw firstRejection.reason;
  }

  // ---- Stats ------------------------------------------------------------------
  const stats: ConvertStats = {
    filesConverted: results.filter((r) => r.status === "converted").length,
    filesRepaired: results.filter((r) => r.status === "repaired").length,
    filesFailed: results.filter((r) => r.status === "failed").length,
    filesDropped: plan.droppedFiles.length,
    calls: batchStats.calls,
    usd: client.usd,
    inputTokens: client.inputTokens,
    outputTokens: client.outputTokens,
    durationMs: Date.now() - startedAt,
  };
  return { results, scaffoldWritten, stats };
}

/** Heuristic: outputs whose path basename resembles the source basename. */
function attributeOutputs(outputs: GeneratedFile[], sourceRel: string): GeneratedFile[] {
  const base = sourceRel.split("/").pop() ?? sourceRel;
  const stem = base.replace(/\.[^.]+$/, "");
  const matches = outputs.filter((o) => {
    const ob = o.path.split("/").pop() ?? o.path;
    const ostem = ob.replace(/\.[^.]+$/, "");
    return ostem === stem || ostem.toLowerCase() === stem.toLowerCase();
  });
  return matches.length > 0 ? matches : outputs;
}
