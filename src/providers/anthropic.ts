/**
 * Anthropic (Claude) provider: retries with backoff, prompt caching,
 * usage/cost tracking, and concurrency-safe accounting shared across the CLI.
 */
import Anthropic from "@anthropic-ai/sdk";
import { pricingFor, usageCost, type ModelPricing, type UsageLike } from "../util/tokens.js";
import { withRetries } from "../util/retry.js";
import { logger } from "../util/logger.js";
import type { CallOptions, CallResult, ChatMessage, ModelClient, ProviderId } from "./types.js";

export class AnthropicClient implements ModelClient {
  readonly provider: ProviderId = "anthropic";
  readonly model: string;
  private client: Anthropic;
  readonly pricing: ModelPricing;

  // Aggregate accounting
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new Anthropic({
      apiKey,
      // Gateway/proxy compatibility: some environments (e.g. agentroute)
      // authenticate with a Bearer token instead of the x-api-key header,
      // and route traffic via ANTHROPIC_BASE_URL. The SDK picks up
      // ANTHROPIC_BASE_URL automatically; authToken must be passed explicitly.
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
      maxRetries: 0,
    });
    this.pricing = pricingFor(model);
  }

  async call(opts: CallOptions): Promise<CallResult> {
    const messages: Anthropic.MessageParam[] = opts.cacheLastUserBlock
      ? withCacheMarker(opts.messages)
      : opts.messages;

    const resp = await withRetries(
      () =>
        this.client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0,
          system: opts.system,
          messages,
        }),
      { maxRetries: opts.maxRetries, label: opts.label },
    );

    this.calls++;
    const usage = resp.usage as unknown as UsageLike;
    const cost = usageCost(this.pricing, usage);
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.usd += cost;

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    logger.debug(
      `[api] ${opts.label ?? "call"}: in=${usage.input_tokens} out=${usage.output_tokens} cost=$${cost.toFixed(4)} stop=${resp.stop_reason}`,
    );

    return {
      text,
      usage,
      costUsd: cost,
      stopReason: resp.stop_reason,
      model: resp.model,
    };
  }
}

function withCacheMarker(messages: ChatMessage[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const last = out[out.length - 1]!;
  if (last.role !== "user") return out;
  if (typeof last.content !== "string") return out;
  out[out.length - 1] = {
    role: "user",
    content: [
      { type: "text" as const, text: last.content, cache_control: { type: "ephemeral" as const } },
    ],
  };
  return out;
}
