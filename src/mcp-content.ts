/**
 * Content builders for the restack MCP server's *prompts* and *resources*.
 *
 - Prompts: reusable, agent-facing message templates that give structured
   guidance (how to drive the scan → plan → convert pipeline, how to resume).
 - Resources: readable context (per-stack conversion notes, CLI reference,
   the current run state) that agents can attach to their own context.

 Kept pure/async-simple so tests can exercise the builders without a transport.
 */
import type {
  GetPromptResult,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { STACK_CONVERSION_NOTES } from "./types.js";
import type { LegacyStack } from "./types.js";
import { pickTarget, targetHelp } from "./targets.js";
import { loadState, type RestackState } from "./state.js";
import path from "node:path";
import { formatCost } from "./util/format.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// URIs
// ---------------------------------------------------------------------------

export const STATE_RESOURCE_URI = "restack://state.json";
export const CLI_REFERENCE_URI = "restack://docs/cli.md";
export const STACK_URI_TEMPLATE = "restack://stacks/{stack}";

/** All legacy stacks with conversion notes (i.e. everything but "unknown"). */
export const KNOWN_STACKS: Exclude<LegacyStack, "unknown">[] = [
  "php-jquery",
  "python2",
  "django",
];

type PromptText = GetPromptResult["messages"][number];

/** Shorthand: a single user-role text message. */
function userMessage(text: string): PromptText {
  return { role: "user", content: { type: "text", text } };
}

// ---------------------------------------------------------------------------
// Prompt: migration_walkthrough
// ---------------------------------------------------------------------------

const PIPELINE_STEPS = `## restack migration walkthrough

You are guiding a legacy → modern migration with the restack MCP tools.
Call the tools in this exact order and check in with the user between steps:

1. **restack_scan** { projectRoot } — no API key needed. Reports the detected
   stack + confidence, file inventory, token estimate and the cost budget the
   packer would use. The machine-readable part is in the \`_restack\` JSON block.

2. **restack_plan** { projectRoot } — dry run (nothing is converted). The
   \`_restack\` block has: fileMappings (source → target paths), routeMappings,
   conversion waves, risks, estimatedCostUsd and planHash. Always pass
   maxCostUsd (default 5).

3. **Review with the user** — show the plan summary, the top risks and the
   estimated cost. Let them trim fileMappings/routeMappings or adjust flags
   (workers, maxCostUsd) before spending anything.

4. **restack_convert** { projectRoot, maxCostUsd, review: true } — the real
   conversion into ./converted with a verify + repair loop and a final
   cross-file consistency review. Do NOT start it without an explicit go-ahead.

5. **restack_status** { outDir } — after any run: per-file statuses, spend,
   what a resume would do.

## Guardrails

- The \`_restack\` JSON block on every tool result is the source of truth —
  parse it, don't guess from prose.
- Never omit maxCostUsd on plan/convert; it is the abort guard.
- Failed files are normal — re-run restack_convert with resume: true and the
  saved plan/state will skip completed files.
- The converted project lands in ./converted — the user must review before
  shipping anything.`;

const NO_STACK_HINT = `The stack is not known yet — start with restack_scan and re-read this
walkthrough's stack notes from the restack://stacks/{stack} resource once detected.`;

function stackSection(stack: LegacyStack | undefined, target: string | undefined): string {
  if (!stack || stack === "unknown") return NO_STACK_HINT;
  const resolvedTarget = target ?? pickTarget(stack) ?? "(no target — auto-detection failed?)";
  const notes = STACK_CONVERSION_NOTES[stack as Exclude<LegacyStack, "unknown">];
  return [
    `## Detected stack: ${stack} → target: ${resolvedTarget}`,
    notes ?? `(no stack-specific notes for ${stack})`,
    `Available context resources: ${STACK_URI_TEMPLATE.replace("{stack}", stack)}, ${CLI_REFERENCE_URI}, ${STATE_RESOURCE_URI}`,
  ].join("\n");
}

/** Build the `migration_walkthrough` prompt result. */
export function buildWalkthroughPrompt(args: { stack?: string; target?: string }): GetPromptResult {
  const stack = KNOWN_STACKS.includes(args.stack as Exclude<LegacyStack, "unknown">)
    ? (args.stack as LegacyStack)
    : undefined;
  if (args.stack && args.stack !== "auto" && !stack) {
    return {
      description: `Unknown stack "${args.stack}"`,
      messages: [
        userMessage(
          `"${args.stack}" is not a known restack stack. Known stacks: ${KNOWN_STACKS.join(", ")}. ` +
            `Run restack_scan on the project first — the stack is detected from its structure. ${targetHelp()}`,
        ),
      ],
    };
  }
  const text = [PIPELINE_STEPS, "", stackSection(stack, args.target)].join("\n");
  return { description: "Step-by-step guide for migrating a legacy project with restack", messages: [userMessage(text)] };
}

// ---------------------------------------------------------------------------
// Prompt: resume_migration
// ---------------------------------------------------------------------------

/**
 * Build the `resume_migration` prompt result. Reads the run state from disk
 * (outDir defaults to ./converted); guidance adapts to what it finds.
 */
export async function buildResumePrompt(args: { outDir?: string }): Promise<GetPromptResult> {
  const outDir = path.resolve(args.outDir ?? "converted");
  const state: RestackState | null = await loadState(outDir);
  if (!state) {
    return {
      description: "No previous restack run found",
      messages: [
        userMessage(
          [
            `No restack run state found in ${outDir} (.restack/state.json is missing).`,
            "",
            "To start a fresh migration instead:",
            "1. Follow the migration_walkthrough prompt: restack_scan → restack_plan → restack_convert.",
            "2. After the first run this prompt will offer resume guidance.",
          ].join("\n"),
        ),
      ],
    };
  }

  const entries = Object.values(state.completedSources);
  const byStatus = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const failedSources = Object.entries(state.completedSources)
    .filter(([, v]) => v.status === "failed")
    .map(([k]) => k);

  const text = [
    `## Resuming a restack migration`,
    "",
    `Previous run found in ${outDir} (.restack/state.json):`,
    `- Project: ${state.projectRoot} → ${state.target} (${state.model})`,
    `- Spend so far: ${formatCost(state.usd)}`,
    `- Files: ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none yet"}`,
    failedSources.length > 0 ? `- Failed sources: ${failedSources.slice(0, 10).join(", ")}${failedSources.length > 10 ? " …" : ""}` : "",
    "",
    "Next steps:",
    "1. restack_status { outDir } — full per-file breakdown and what a resume would do.",
    "2. restack_convert { projectRoot, outDir, resume: true, maxCostUsd } — reuses the saved plan",
    "   and state; already-converted files are skipped, only the rest is (re)done.",
    "3. Once every file is converted/repaired, a final restack_convert with review: true keeps",
    "   the whole output consistent.",
    "",
    "Read the state resource for the raw record: " + STATE_RESOURCE_URI,
  ].filter(Boolean).join("\n");
  return {
    description: `Resume the restack run in ${outDir}`,
    messages: [userMessage(text)],
  };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Build the per-stack conversion-notes resource content. */
export function buildStackResource(stack: string, uri: string): ReadResourceResult {
  if (!KNOWN_STACKS.includes(stack as Exclude<LegacyStack, "unknown">)) {
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: `Unknown stack "${stack}". Known stacks: ${KNOWN_STACKS.join(", ")}. Run restack_scan on a project to detect its stack. ${targetHelp()}`,
      }],
    };
  }
  const target = pickTarget(stack as LegacyStack) ?? "(none)";
  const notes = STACK_CONVERSION_NOTES[stack as Exclude<LegacyStack, "unknown">];
  return {
    contents: [{
      uri,
      mimeType: "text/markdown",
      text: [
        `# Legacy stack: ${stack}`,
        "",
        `Modern target: **${target}**`,
        "",
        "Conversion notes (the same guidance the converter uses):",
        "",
        notes ?? "(none)",
      ].join("\n"),
    }],
  };
}

/** List the stack resources exposed behind the stacks template. */
export function listStackResources(): { resources: Resource[] } {
  return {
    resources: KNOWN_STACKS.map((stack) => ({
      uri: STACK_URI_TEMPLATE.replace("{stack}", stack),
      name: `Conversion notes: ${stack}`,
      description: `Legacy stack notes for ${stack} and its modern target`,
      mimeType: "text/markdown",
    })),
  };
}

/** Build the compact CLI reference resource content. */
export function buildCliReferenceResource(uri: string): ReadResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "text/markdown",
      text: [
        `# restack CLI reference (v${VERSION})`,
        "",
        "Full docs: https://hrishabhadarsh123.github.io/restack/cli-reference",
        "",
        "- `restack scan <project> [--json] [--include <glob>]... [--exclude <glob>]...`",
        "  Detect the legacy stack, inventory files, estimate tokens. No API key needed.",
        "- `restack plan <project> [--target nextjs|fastapi] [--provider anthropic|openai|google] [--model <id>] [--max-cost <usd>] [--json] [--interactive]`",
        "  Build a migration plan (dry run). Requires a provider key.",
        "- `restack convert <project> [--out <dir>] [--target ...] [--provider ...] [--model ...] [--workers 1-8] [--max-cost <usd>] [--resume] [--review] [--json] [--interactive]`",
        "  Plan + batched conversion into ./converted with verify/repair and optional review pass.",
        "- `restack status [--out <dir>] [--json]`",
        "  Inspect the last run: per-file statuses, spend, what would resume.",
        "- `restack mcp`",
        "  Run the MCP server over stdio (tools + prompts + resources).",
        "",
        "Environment: one of ANTHROPIC_API_KEY, OPENAI_API_KEY / OPENROUTER_API_KEY (+ OPENAI_BASE_URL for any OpenAI-compatible endpoint), GEMINI_API_KEY.",
      ].join("\n"),
    }],
  };
}

/**
 * Build the run-state resource content. Reads `<cwd>/converted/.restack/state.json`
 * — the same default the CLI/MCP tools use.
 */
export async function buildStateResource(uri: string): Promise<ReadResourceResult> {
  const outDir = path.resolve("converted");
  const state = await loadState(outDir);
  if (!state) {
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: `No restack state found in ${outDir} — run restack_convert first (or use the restack_status tool with an explicit outDir).`,
      }],
    };
  }
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state, null, 2) }] };
}
