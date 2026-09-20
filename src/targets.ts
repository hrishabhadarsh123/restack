/**
 * Stack → target auto-mapping shared by the CLI and the MCP server.
 * CLI paths keep process.exit(1) with a friendly message; MCP paths need a
 * non-throwing answer so the tool call can return a structured error instead.
 */
import type { ModernTarget, ScanResult } from "./types.js";

/** Returns null when no confident auto-mapping exists (caller decides what to do). */
export function pickTarget(stack: LegacyStackLike): ModernTarget | null {
  if (stack === "php-jquery") return "nextjs";
  if (stack === "django") return "fastapi";
  if (stack === "python2") return "fastapi";
  return null;
}

/** Loose type so this module does not import the full ScanResult type. */
type LegacyStackLike = ScanResult["stack"];

export function targetHelp(): string {
  return 'Pass --target nextjs|fastapi explicitly, or add more stack markers to the scanner.';
}
