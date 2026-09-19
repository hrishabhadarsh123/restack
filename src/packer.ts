/**
 * Packer: decides what goes into the planning prompt within the context
 * budget. Priority: entry/config/route/shared first, then templates, styles
 * and other files. Oversized files get summarized (head/tail) instead of
 * packed verbatim.
 */
import type { FileEntry, ScanResult } from "./types.js";
import { estimateTokens, CHARS_PER_TOKEN } from "./util/tokens.js";

export interface Packed {
  /** Full text of the packed context section (XML-ish, Claude-friendly). */
  text: string;
  /** rel-paths included verbatim. */
  verbatim: string[];
  /** rel-paths included as head/tail summaries. */
  summarized: string[];
  /** rel-paths left out entirely (referenced only in the inventory). */
  omitted: string[];
  /** Estimated tokens of `text`. */
  tokens: number;
}

export interface PackOptions {
  /** Token budget for the packed source section (excludes inventory/prompt scaffolding). */
  tokenBudget: number;
  /** Verbatim threshold: files <= this are packed fully when budget allows. */
  verbatimMaxTokens?: number;
}

const ROLE_PRIORITY: Record<string, number> = {
  entry: 0,
  config: 1,
  route: 2,
  shared: 3,
  template: 4,
  component: 5,
  test: 8,
  style: 9,
  other: 6,
};

export function packContext(scan: ScanResult, opts: PackOptions): Packed {
  const verbatimMaxTokens = opts.verbatimMaxTokens ?? 3_500;
  const budget = opts.tokenBudget;

  // Budget split: ~78% verbatim, ~20% summarized, ~2% slack.
  const verbatimBudget = Math.floor(budget * 0.78);
  const summaryBudget = Math.floor(budget * 0.2);

  const candidates = scan.files.filter((f) => f.text != null);
  const sorted = [...candidates].sort((a, b) => {
    const pa = ROLE_PRIORITY[a.role] ?? 7;
    const pb = ROLE_PRIORITY[b.role] ?? 7;
    if (pa !== pb) return pa - pb;
    // Within a role, smaller files first so we pack more distinct files.
    return a.tokens - b.tokens;
  });

  const verbatim: string[] = [];
  const summarized: string[] = [];
  const omitted: string[] = [];
  const sections: string[] = [];
  let used = 0;
  let summaryUsed = 0;

  const wrap = (rel: string, body: string) =>
    `<file path="${rel}">\n${body.trim()}\n</file>`;

  for (const f of sorted) {
    const text = f.text!;
    const isEntryLike = f.role === "entry" || f.role === "config";
    // Entry/config files are the planner's most important context: they may
    // exceed the per-file verbatim cap and borrow from the summary budget,
    // as long as the total budget holds.
    const canVerbatim =
      used + f.tokens <= (isEntryLike ? budget : verbatimBudget) &&
      (isEntryLike || f.tokens <= verbatimMaxTokens);
    if (canVerbatim) {
      sections.push(wrap(f.rel, text));
      used += f.tokens + 8; // small per-file XML overhead
      verbatim.push(f.rel);
      continue;
    }
    // Summarize head+tail adaptively into the remaining summary budget.
    const summaryRoom = summaryBudget - summaryUsed;
    if (summaryRoom >= 200) {
      const body = summarizeHeadTail(text, summaryRoom);
      sections.push(wrap(f.rel, `<!-- SUMMARIZED: large file, head+tail shown -->\n${body}`));
      summaryUsed += estimateTokens(body) + 8;
      summarized.push(f.rel);
      continue;
    }
    omitted.push(f.rel);
  }

  const inventory = buildInventory(scan, { verbatim, summarized, omitted });

  const text = [
    "## Project file inventory",
    "",
    inventory,
    "",
    "## Source files",
    "",
    ...sections,
  ].join("\n");

  return {
    text,
    verbatim,
    summarized,
    omitted,
    tokens: estimateTokens(text),
  };
}

/** Head+tail summary with an explicit truncation marker; fits within tokenBudget tokens. */
function summarizeHeadTail(text: string, tokenBudget: number): string {
  const budgetChars = Math.max(400, Math.floor(tokenBudget * CHARS_PER_TOKEN));
  if (text.length <= budgetChars) return text;
  // Reserve room for the marker text itself.
  const markerChars = 60;
  const usable = budgetChars - markerChars;
  const headChars = Math.floor(usable * 0.8);
  const tailChars = usable - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omittedTokens = Math.round((text.length - headChars - tailChars) / CHARS_PER_TOKEN);
  return `${head}\n\n<!-- ... middle truncated (~${omittedTokens} tokens) ... -->\n\n${tail}`;
}

function buildInventory(
  scan: ScanResult,
  state: { verbatim: string[]; summarized: string[]; omitted: string[] },
): string {
  const lines: string[] = [];
  const inContext = new Set([...state.verbatim, ...state.summarized]);
  const missing: string[] = [];

  for (const f of scan.files) {
    const flag = f.text == null ? " [unreadable/binary]" : "";
    lines.push(`- ${f.rel} (${f.language}, ~${f.tokens} tok, role=${f.role})${flag}`);
    if (!inContext.has(f.rel)) missing.push(f.rel);
  }

  if (missing.length > 0) {
    lines.push(
      "",
      `Files listed above but NOT included in the source section (${missing.length}): ${missing.slice(0, 50).join(", ")}${missing.length > 50 ? ", ..." : ""}`,
    );
  }
  if (scan.excludedSensitive.length > 0) {
    lines.push(
      `Sensitive files excluded from context entirely: ${scan.excludedSensitive.join(", ")}`,
    );
  }
  return lines.join("\n");
}
