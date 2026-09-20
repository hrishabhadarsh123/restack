/**
 * OpenAI provider — and any OpenAI-compatible endpoint (OpenRouter, Groq,
 * Together, Ollama, ...) via OPENAI_BASE_URL / an explicit baseURL.
 *
 * Notes:
 * - Reasoning families (o*, gpt-5*) need max_completion_tokens and reject a
 *   custom temperature; classic chat models take max_tokens + temperature.
 * - Prompt caching is automatic server-side for long prompts; the
 *   Anthropic-style cache marker is simply ignored here.
 */
import OpenAI from "openai";
import { pricingFor, usageCost, type ModelPricing, type UsageLike } from "../util/tokens.js";
import { withRetries } from "../util/retry.js";
import { logger } from "../util/logger.js";
import type { CallOptions, CallResult, ModelClient, ProviderId } from "./types.js";

/** Reasoning families (o1/o3/o4…, gpt-5*) use max_completion_tokens + fixed temperature. */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

export interface OpenAIClientOptions {
  /** Override the endpoint (OpenRouter, Groq, Ollama, ...). Defaults to OPENAI_BASE_URL. */
  baseURL?: string;
  /** Test hook: inject a custom fetch (the OpenAI SDK supports it natively). */
  fetch?: typeof fetch;
}

export class OpenAIClient implements ModelClient {
  readonly provider: ProviderId = "openai";
  readonly model: string;
  private client: OpenAI;
  readonly pricing: ModelPricing;

  // Aggregate accounting
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;

  constructor(apiKey: string, model: string, opts: OpenAIClientOptions = {}) {
    this.model = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL ?? (process.env.OPENAI_BASE_URL || undefined),
      maxRetries: 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.pricing = pricingFor(model);
  }

  async call(opts: CallOptions): Promise<CallResult> {
    const reasoning = isReasoningModel(opts.model);
    const resp = await withRetries(
      () =>
        this.client.chat.completions.create({
          model: opts.model,
          messages: [
            { role: "system", content: opts.system },
            // ChatMessage shape matches OpenAI chat params for plain text.
            ...opts.messages,
          ],
          ...(reasoning
            ? { max_completion_tokens: opts.maxTokens }
            : { max_tokens: opts.maxTokens, temperature: opts.temperature ?? 0 }),
        }),
      { maxRetries: opts.maxRetries, label: opts.label },
    );

    this.calls++;
    const usage = openAIUsage(resp.usage);
    const cost = usageCost(this.pricing, usage);
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.usd += cost;

    const choice = resp.choices[0];
    const text = choice?.message?.content ?? "";

    logger.debug(
      `[api/openai] ${opts.label ?? "call"}: in=${usage.input_tokens} out=${usage.output_tokens} cost=$${cost.toFixed(4)} stop=${choice?.finish_reason ?? "null"}`,
    );

    return {
      text,
      usage,
      costUsd: cost,
      stopReason: choice?.finish_reason ?? null,
      model: resp.model,
    };
  }
}

/** Map an OpenAI (or compatible) usage payload onto our UsageLike shape. */
export function openAIUsage(
  u: OpenAI.CompletionUsage | undefined,
): UsageLike {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const cached = (u as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details
    ?.cached_tokens;
  const usage: UsageLike = {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
  };
  if (cached != null) usage.cache_read_input_tokens = cached;
  return usage;
}
