/**
 * Shared retry policy for all model providers: exponential backoff with
 * jitter on transient HTTP/network failures, rethrowing anything else.
 * SDK-level retries stay disabled (maxRetries: 0) — this is the single
 * retry layer, so cost accounting and logging stay consistent.
 */
import { logger } from "./logger.js";

export function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) return true;
  const code = (err as { code?: string })?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") return true;
  return false;
}

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Gateways/WAFs sometimes return huge HTML bodies — keep log lines sane.
  return raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  label?: string;
}

export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt > maxRetries || !isRetryableError(err)) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      logger.warn(
        `API error (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(delay / 100) / 10}s: ${errMsg(err)}`,
      );
      await sleep(delay);
    }
  }
}
