/**
 * Provider-agnostic model client contract.
 *
 * planner / converter-core / review only ever talk to a ModelClient — the
 * concrete implementation (Anthropic, OpenAI-compatible, Gemini) is resolved
 * from the environment or the --provider flag. Adding a provider means
 * implementing this interface; no pipeline code changes.
 */
import type { ModelPricing, UsageLike } from "../util/tokens.js";

export type ProviderId = "anthropic" | "openai" | "google";

/** A single chat turn. All our prompts are plain text (no vision/tools). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallOptions {
  model: string;
  maxTokens: number;
  system: string;
  messages: ChatMessage[];
  /** Mark the last user message as cacheable (Anthropic prompt caching; others cache implicitly). */
  cacheLastUserBlock?: boolean;
  temperature?: number;
  /** Override the default retry policy. */
  maxRetries?: number;
  /** Label used in logs. */
  label?: string;
}

export interface CallResult {
  text: string;
  usage: UsageLike;
  costUsd: number;
  stopReason: string | null;
  model: string;
}

/**
 * Everything the pipeline needs from a model provider. The aggregate
 * counters (calls/inputTokens/outputTokens/usd) are mutated by the
 * implementation and read for cost accounting, state persistence and the
 * --json event stream.
 */
export interface ModelClient {
  readonly provider: ProviderId;
  readonly model: string;
  readonly pricing: ModelPricing;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  call(opts: CallOptions): Promise<CallResult>;
}
