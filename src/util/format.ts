/**
 * Formatting helpers for human-readable CLI output.
 */
import pc from "picocolors";

/** 1234567 -> "1.2M", 4200 -> "4.2k" */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return trim(n / 1_000_000) + "M";
  if (abs >= 10_000) return Math.round(n / 1000) + "k";
  if (abs >= 1_000) return trim(n / 1000) + "k";
  return String(n);
}

/** Format USD cost with sensible precision. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "$" + usd.toFixed(4);
  if (usd < 100) return "$" + usd.toFixed(2);
  return "$" + Math.round(usd).toLocaleString("en-US");
}

/** Estimate/usage display: "42.3k / 200k tokens" */
export function formatTokens(used: number, budget?: number): string {
  const usedStr = formatCount(Math.round(used));
  if (budget == null) return usedStr;
  return `${usedStr} / ${formatCount(budget)} tokens`;
}

/** Percent with one decimal. */
export function formatPercent(fraction: number): string {
  return (fraction * 100).toFixed(1) + "%";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${m}m ${rest}s`;
}

function trim(n: number): string {
  // one decimal, drop trailing ".0"
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Simple key/value table printer for scan summaries. */
export function printTable(rows: Array<[string, string]>, colors = true): void {
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    const key = colors ? pc.bold(pc.cyan(k.padEnd(width))) : k.padEnd(width);
    process.stderr.write(`  ${key}  ${v}\n`);
  }
}
