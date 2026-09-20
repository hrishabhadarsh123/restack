/**
 * restack MCP server — exposes the scan/plan/convert/status pipeline as MCP
 * tools over stdio, so agent platforms (Google Antigravity, Hermes Agent,
 * Claude Code, Cursor, ...) can drive legacy→modern migrations directly.
 *
 * Tools return text (agent-facing summaries) plus a `_restack` JSON block
 * (machine-readable payload) when the underlying command supports --json.
 * Human logs stay on stderr; the MCP stdio transport owns stdout.
 *
 * Run: `restack mcp` (stdio transport — the standard for local agent tools).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { scanProject, buildScanJsonReport } from "./scanner.js";
import { runPlanner, buildPlanJsonReport } from "./planner.js";
import { runConverter } from "./converter-core.js";
import { runReview } from "./review.js";
import { pickTarget, targetHelp } from "./targets.js";
import { selectProvider, createClient, warnModelMismatch, DEFAULT_MODELS } from "./providers/index.js";
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
  type MigrationPlan,
  type ModernTarget,
  type ScanResult,
} from "./types.js";
import { logger } from "./util/logger.js";
import { VERSION } from "./version.js";
import { formatCost, formatDuration, formatPercent, formatTokens } from "./util/format.js";

/** Format a scan result as an agent-facing summary. */
function scanSummary(scan: ScanResult): string {
  const lines = [
    `Stack: ${scan.stack} (confidence ${formatPercent(scan.confidence)})`,
    ...scan.evidence.map((e) => `• ${e}`),
    scan.libraries.length > 0 ? `libraries: ${scan.libraries.join(", ")}` : "",
    `files: ${scan.files.length} scanned, ${scan.files.filter((f) => f.text != null).length} readable`,
    `estimated tokens: ${formatTokens(scan.totalTokens)} — ${scan.totalTokens <= 160_000 ? "fits in one 200k window" : "packer will summarize"}`,
    scan.excludedSensitive.length > 0
      ? `excluded sensitive files (never read): ${scan.excludedSensitive.slice(0, 8).join(", ")}${scan.excludedSensitive.length > 8 ? " …" : ""}`
      : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Resolve the target for a scan, or return an error message. */
function resolveMcpTarget(scan: ScanResult, explicit?: string): { target?: ModernTarget; error?: string } {
  if (explicit) {
    if (explicit === "nextjs" || explicit === "fastapi") return { target: explicit };
    return { error: `Unknown target "${explicit}". Use "nextjs" or "fastapi".` };
  }
  const picked = pickTarget(scan.stack);
  if (!picked) return { error: `Could not auto-detect a target for stack "${scan.stack}". ${targetHelp()}` };
  return { target: picked };
}

/** Shared setup: scan + provider selection + client. */
function setup(
  provider?: string,
  model?: string,
): { client: ModelClient; sel: NonNullable<ReturnType<typeof selectProvider>>; resolvedModel: string } | { error: string } {
  const sel = selectProvider(provider);
  if (!sel) return { error: "No model provider key found in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY/OPENROUTER_API_KEY, or GEMINI_API_KEY)." };
  const resolvedModel = model ?? DEFAULT_MODELS[sel.id];
  warnModelMismatch(sel, resolvedModel);
  return { client: createClient(sel, resolvedModel), sel, resolvedModel };
}

/** Wrap a tool body: log errors instead of crashing the stdio transport. */
async function tool(body: () => Promise<{ text: string; json?: unknown }>): Promise<{
  content: { type: "text"; text: string }[];
}> {
  try {
    const out = await body();
    const text = out.json !== undefined ? `${out.text}\n\n_restack: ${JSON.stringify(out.json)}` : out.text;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    if (err instanceof CostLimitError) {
      return { content: [{ type: "text", text: `Cost limit reached: ${err.message}` }] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`tool error: ${err instanceof Error ? err.stack : msg}`);
    return { content: [{ type: "text", text: `restack error: ${msg}` }] };
  }
}

/** Build the MCP server with all restack tools registered. */
export function createRestackMcpServer(): McpServer {
  const server = new McpServer(
    { name: "restack", version: VERSION },
    { instructions: "Convert legacy codebases (PHP/jQuery, Python 2, Django) to modern stacks (Next.js, FastAPI). Start with restack_scan, then restack_plan (dry-run) before a full restack_convert." },
  );

  server.tool(
    "restack_scan",
    "Analyze a legacy project: detect the stack, inventory files, estimate tokens and cost. No API key needed.",
    {
      projectRoot: z.string().describe("Absolute or relative path to the legacy project"),
      includeGlobs: z.array(z.string()).optional().describe("Only include files matching these globs"),
      excludeGlobs: z.array(z.string()).optional().describe("Exclude files matching these globs"),
    },
    async ({ projectRoot, includeGlobs, excludeGlobs }) =>
      tool(async () => {
        const scan = await scanProject(projectRoot, { includeGlobs, excludeGlobs });
        return { text: scanSummary(scan), json: buildScanJsonReport(scan) };
      }),
  );

  server.tool(
    "restack_plan",
    "Generate a migration plan (dry run — nothing is converted): file mappings, route table, dependency waves, risks. Requires a provider key.",
    {
      projectRoot: z.string().describe("Path to the legacy project"),
      target: z.enum(["nextjs", "fastapi"]).optional().describe("Modern target (auto-detected from the stack if omitted)"),
      provider: z.enum(["anthropic", "openai", "google"]).optional().describe("Model provider (auto-detected from env if omitted)"),
      model: z.string().optional().describe("Model id (provider default if omitted)"),
      maxCostUsd: z.number().optional().describe("Abort if the estimated spend exceeds this (default 5)"),
    },
    async ({ projectRoot, target, provider, model, maxCostUsd }) =>
      tool(async () => {
        const scan = await scanProject(projectRoot);
        const resolved = resolveMcpTarget(scan, target);
        if (resolved.error || !resolved.target) return { text: resolved.error ?? "target resolution failed" };
        const s = setup(provider, model);
        if ("error" in s) return { text: s.error };

        const outcome = await runPlanner(s.client, scan, {
          target: resolved.target,
          model: s.resolvedModel,
          maxCostUsd: maxCostUsd ?? 5,
        });
        const outDir = path.resolve("converted");
        await savePlan(outDir, outcome.plan);
        const planHash = computePlanHash(outcome.plan, {
          root: scan.root,
          stack: scan.stack,
          files: scan.files.map((f) => ({ rel: f.rel, size: f.size })),
        });
        const report = buildPlanJsonReport(scan, outcome.plan, {
          planHash,
          usd: outcome.usd,
          calls: outcome.calls,
        });
        return {
          text: [
            `Plan ready (${outcome.plan.fileMappings.length} mappings, ${outcome.plan.conversionOrder.length} waves) — ${formatCost(outcome.usd)}`,
            `Summary: ${outcome.plan.summary}`,
            outcome.plan.risks.length > 0 ? `Risks: ${outcome.plan.risks.slice(0, 5).join("; ")}` : "",
            `Saved to ${path.join(outDir, ".restack", "plan.json")}`,
          ].filter(Boolean).join("\n"),
          json: report,
        };
      }),
  );

  server.tool(
    "restack_convert",
    "Full conversion: plan + batched file-by-file conversion into a new project (verify + repair loop). Requires a provider key. Review the plan first with restack_plan.",
    {
      projectRoot: z.string().describe("Path to the legacy project"),
      outDir: z.string().optional().describe("Output directory for the converted project (default ./converted)"),
      target: z.enum(["nextjs", "fastapi"]).optional().describe("Modern target (auto-detected if omitted)"),
      provider: z.enum(["anthropic", "openai", "google"]).optional().describe("Model provider (auto-detected from env)"),
      model: z.string().optional().describe("Model id (provider default if omitted)"),
      workers: z.number().int().min(1).max(8).optional().describe("Parallel conversion batches (default 2)"),
      maxCostUsd: z.number().optional().describe("Hard spend limit in USD (default 20)"),
      resume: z.boolean().optional().describe("Resume an interrupted run (reuse .restack/plan.json and state)"),
      review: z.boolean().optional().describe("Run a final cross-file consistency review pass"),
    },
    async ({ projectRoot, outDir, target, provider, model, workers, maxCostUsd, resume, review }) =>
      tool(async () => {
        const scan = await scanProject(projectRoot);
        const resolved = resolveMcpTarget(scan, target);
        if (resolved.error || !resolved.target) return { text: resolved.error ?? "target resolution failed" };
        const s = setup(provider, model);
        if ("error" in s) return { text: s.error };

        const out = path.resolve(outDir ?? "converted");
        const resolvedModel = s.resolvedModel;
        const existingState = await loadState(out);
        const resuming = resume === true && existingState != null;

        let plan: MigrationPlan;
        const savedPlan = resuming ? await loadPlan<MigrationPlan>(out) : null;
        if (savedPlan) {
          plan = savedPlan;
        } else {
          const planned = await runPlanner(s.client, scan, { target: resolved.target, model: resolvedModel, maxCostUsd: maxCostUsd ?? 20 });
          plan = planned.plan;
          await savePlan(out, plan);
        }

        const planHash = computePlanHash(plan, {
          root: scan.root,
          stack: scan.stack,
          files: scan.files.map((f) => ({ rel: f.rel, size: f.size })),
        });
        const state = existingState ?? {
          version: 1 as const,
          projectRoot: scan.root,
          target: resolved.target,
          model: resolvedModel,
          planHash,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          usd: 0,
          completedSources: {},
        };
        const skipSources = new Set(
          Object.entries(state.completedSources)
            .filter(([, v]) => v.status === "converted" || v.status === "repaired")
            .map(([k]) => k),
        );

        const startedAt = Date.now();
        const outcome = await runConverter(s.client, scan, plan, out, {
          target: resolved.target,
          model: resolvedModel,
          workers: workers ?? 2,
          maxCostUsd: maxCostUsd ?? 20,
          skipSources,
        });

        if (review) {
          await runReview(s.client, plan, out, { target: resolved.target, model: resolvedModel, maxCostUsd: maxCostUsd ?? 20 });
        }

        for (const r of outcome.results) {
          state.completedSources[r.source] = {
            status: r.status,
            outputs: r.outputs.map((o) => o.path),
            attempts: r.attempts,
            error: r.error,
          };
        }
        state.usd = s.client.usd;
        state.updatedAt = new Date().toISOString();
        await saveState(out, state);

        const lines = [
          `Converted ${outcome.stats.filesConverted} file(s) (${outcome.stats.filesRepaired} repaired, ${outcome.stats.filesFailed} failed) in ${formatDuration(Date.now() - startedAt)} — total spend ${formatCost(s.client.usd)}`,
          `Output: ${out}`,
          outcome.stats.filesFailed > 0 ? "⚠ Some files failed verification — inspect errors and re-run with resume: true." : "",
        ].filter(Boolean);
        return {
          text: lines.join("\n"),
          json: {
            schema: REPORT_SCHEMA_VERSION,
            event: "summary",
            outDir: out,
            stats: outcome.stats,
            statePath: path.join(out, ".restack", "state.json"),
          },
        };
      }),
  );

  server.tool(
    "restack_status",
    "Inspect a previous conversion: saved plan, per-file statuses, spend, and what would resume.",
    {
      outDir: z.string().optional().describe("Output directory holding .restack/ state (default ./converted)"),
    },
    async ({ outDir }) =>
      tool(async () => {
        const dir = path.resolve(outDir ?? "converted");
        const state = await loadState(dir);
        if (!state) {
          return { text: `No restack state found in ${dir} — run restack_convert first.` };
        }
        const savedPlan = await loadPlan<MigrationPlan>(dir);
        const entries = Object.entries(state.completedSources);
        const byStatus = entries.reduce<Record<string, number>>((acc, [, v]) => {
          acc[v.status] = (acc[v.status] ?? 0) + 1;
          return acc;
        }, {});
        const completed = new Set(
          entries.filter(([, v]) => v.status === "converted" || v.status === "repaired").map(([k]) => k),
        );
        const remaining = savedPlan
          ? savedPlan.fileMappings.filter((m) => m.targets.length > 0 && !completed.has(m.source)).length
          : null;
        return {
          text: [
            `Project: ${state.projectRoot} → ${state.target} (${state.model})`,
            `Files: ${entries.length} tracked — ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none yet"}`,
            `Spend so far: ${formatCost(state.usd)}`,
            remaining === null ? "No saved plan found in .restack/" : `Remaining files if resumed: ${remaining}`,
            `State: ${path.join(dir, ".restack", "state.json")}`,
          ].join("\n"),
          json: {
            schema: REPORT_SCHEMA_VERSION,
            event: "status",
            state,
            remainingFiles: remaining,
          },
        };
      }),
  );

  return server;
}

/** Entry point for `restack mcp`: stdio transport, logs already on stderr. */
export async function runMcpServer(): Promise<void> {
  const server = createRestackMcpServer();
  await server.connect(new StdioServerTransport());
  logger.info(`restack MCP server v${VERSION} ready on stdio (tools: restack_scan, restack_plan, restack_convert, restack_status)`);
}
