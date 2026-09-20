/**
 * restack SDK — programmatic access to the legacy→modern migration pipeline,
 * for hosts that embed restack rather than shell out to the CLI.
 *
 * ```ts
 * import { scanProject, runPlanner, runConverter, selectProvider, createClient } from "restack-ai";
 *
 * const scan = await scanProject("./legacy-app");
 * const sel = selectProvider();                    // or selectProvider("openai")
 * const client = createClient(sel, "gpt-5.2");
 * const { plan } = await runPlanner(client, scan, { target: "nextjs", model: "gpt-5.2" });
 * await runConverter(client, scan, plan, "./converted", { target: "nextjs", model: "gpt-5.2", workers: 2 });
 * ```
 *
 * The same pipeline is exposed as an MCP server via `runMcpServer()` (or the
 * `restack mcp` CLI command) for agent platforms (Google Antigravity, Hermes
 * Agent, Claude Code, Cursor, ...).
 */
export { scanProject, buildScanJsonReport } from "./scanner.js";
export { runPlanner, buildPlanJsonReport } from "./planner.js";
export { runConverter, writeGeneratedFiles } from "./converter-core.js";
export { runReview } from "./review.js";
export { pickTarget, targetHelp } from "./targets.js";
export {
  selectProvider,
  createClient,
  detectProvider,
  warnModelMismatch,
  DEFAULT_MODELS,
  PROVIDER_ENV,
  PROVIDER_IDS,
} from "./providers/index.js";
export { createRestackMcpServer, runMcpServer } from "./mcp.js";
export { VERSION } from "./version.js";
export {
  loadState,
  saveState,
  savePlan,
  loadPlan,
  computePlanHash,
  CostLimitError,
} from "./state.js";
export * from "./types.js";
