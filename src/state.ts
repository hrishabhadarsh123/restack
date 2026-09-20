/**
 * Checkpoint state: persisted under <outDir>/.restack/state.json so an
 * interrupted conversion can resume, and cumulative spend survives runs.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import type { ModernTarget, FileResult } from "./types.js";
import type { InteractiveOptions } from "./interactive.js";

export const STATE_DIR_NAME = ".restack";
export const STATE_FILE_NAME = "state.json";
export const PLAN_FILE_NAME = "plan.json";

export interface CompletedSource {
  status: FileResult["status"];
  outputs: string[];
  attempts: number;
  error?: string;
}

export interface RestackState {
  version: 1;
  projectRoot: string;
  target: ModernTarget;
  model: string;
  planHash: string;
  createdAt: string;
  updatedAt: string;
  /** Cumulative USD spend recorded across runs. */
  usd: number;
  completedSources: Record<string, CompletedSource>;
  /** Interactive selections (--interactive) so --resume reproduces the same subset. */
  interactive?: InteractiveOptions;
}

export function statePath(outDir: string): string {
  return path.join(outDir, STATE_DIR_NAME, STATE_FILE_NAME);
}

export function planPath(outDir: string): string {
  return path.join(outDir, STATE_DIR_NAME, PLAN_FILE_NAME);
}

export async function loadState(outDir: string): Promise<RestackState | null> {
  try {
    const raw = await fsp.readFile(statePath(outDir), "utf8");
    const parsed = JSON.parse(raw) as RestackState;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveState(outDir: string, state: RestackState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const file = statePath(outDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

export function computePlanHash(
  plan: unknown,
  fingerprint: { root: string; stack: string; files: Array<{ rel: string; size: number }> },
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(plan));
  h.update(fingerprint.root);
  h.update(fingerprint.stack);
  for (const f of [...fingerprint.files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    h.update(`${f.rel}:${f.size}`);
  }
  return h.digest("hex").slice(0, 16);
}

export async function savePlan(outDir: string, plan: unknown): Promise<void> {
  const file = planPath(outDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(plan, null, 2), "utf8");
}

export async function loadPlan<T>(outDir: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(planPath(outDir), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Thrown when the --max-cost budget would be exceeded by the next call. */
export class CostLimitError extends Error {
  constructor(public estimatedTotal: number, public limit: number) {
    super(
      `Cost guard: estimated spend $${estimatedTotal.toFixed(2)} would exceed --max-cost $${limit.toFixed(2)}. ` +
        "Use --max-cost to raise the limit or --resume to continue an existing run.",
    );
    this.name = "CostLimitError";
  }
}
