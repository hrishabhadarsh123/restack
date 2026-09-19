/**
 * Token estimation and cost math shared by scan/plan/convert.
 *
 * We use a chars-per-token heuristic (~3.8 chars/token for mixed
 * natural-language + source code, which matches Claude tokenizers closely
 * enough for budgeting). Never use this for hard limits — the packer keeps
 * a safety margin.
 */
export const CHARS_PER_TOKEN = 3.8;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Rough per-million-USD pricing per model (updated 2026-09; overridable via --model pricing table). */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Prompt-cache read price per million (Anthropic cache reads are ~10% of input). */
  cacheReadPerMillion: number;
  /** Prompt-cache write price per million (Anthropic cache writes are ~25% premium). */
  cacheWritePerMillion: number;
  maxOutputTokens: number;
  contextWindow: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
  },
  "claude-opus-4-1": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
    maxOutputTokens: 32_000,
    contextWindow: 200_000,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
    maxOutputTokens: 64_000,
    contextWindow: 200_000,
  },
};

const FALLBACK_PRICING: ModelPricing = PRICING["claude-sonnet-4-5"]!;

export function pricingFor(model: string): ModelPricing {
  // Accept aliases like "claude-sonnet-4-5-20250929"
  for (const key of Object.keys(PRICING)) {
    if (model === key || model.startsWith(key)) return PRICING[key]!;
  }
  return FALLBACK_PRICING;
}

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function usageCost(pricing: ModelPricing, usage: UsageLike): number {
  const input = (usage.input_tokens - (usage.cache_read_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0)) / 1e6;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) / 1e6;
  const cacheWrite = (usage.cache_creation_input_tokens ?? 0) / 1e6;
  const output = usage.output_tokens / 1e6;
  return (
    input * pricing.inputPerMillion +
    cacheRead * pricing.cacheReadPerMillion +
    cacheWrite * pricing.cacheWritePerMillion +
    output * pricing.outputPerMillion
  );
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Estimate cost of a single call from packed token counts. */
export function estimateCallCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  opts: { cachedInputTokens?: number; uncachedInputTokens?: number } = {},
): CostEstimate {
  const output = outputTokens / 1e6 * pricing.outputPerMillion;
  if (opts.uncachedInputTokens != null) {
    const cached = opts.cachedInputTokens ?? 0;
    const uncached = opts.uncachedInputTokens;
    const usd =
      (uncached / 1e6) * pricing.inputPerMillion +
      (cached / 1e6) * pricing.cacheReadPerMillion +
      output;
    return { inputTokens: cached + uncached, outputTokens, usd };
  }
  // No cache assumed
  const usd = (inputTokens / 1e6) * pricing.inputPerMillion + output;
  return { inputTokens, outputTokens, usd };
}
