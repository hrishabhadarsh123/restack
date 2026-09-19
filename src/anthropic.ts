/**
 * Anthropic client wrapper: retries with backoff, prompt caching, usage/cost
 * tracking, and concurrency-safe accounting shared across the CLI.
 */
import Anthropic from "@anthropic-ai/sdk";
import { pricingFor, usageCost, type ModelPricing, type UsageLike } from "./util/tokens.js";
import { logger } from "./util/logger.js";

export interface CallOptions {
  model: string;
  maxTokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
  /** Mark the last user message block as cacheable (prompt caching). */
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

export class AnthropicClient {
  private client: Anthropic;
  readonly pricing: ModelPricing;

  // Aggregate accounting
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;

  constructor(apiKey: string, model: string) {
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
    const maxRetries = opts.maxRetries ?? 5;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      try {
        const messages = opts.cacheLastUserBlock
          ? withCacheMarker(opts.messages)
          : opts.messages;

        const resp = await this.client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0,
          system: opts.system,
          messages,
        });

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
      } catch (err) {
        if (attempt > maxRetries) throw err;
        const retryable = isRetryable(err);
        if (!retryable) throw err;
        const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
        logger.warn(`API error (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(delay / 100) / 10}s: ${errMsg(err)}`);
        await sleep(delay);
      }
    }
  }
}

function withCacheMarker(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1]!;
  if (last.role !== "user") return out;
  if (typeof last.content === "string") {
    out[out.length - 1] = {
      role: "user",
      content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }],
    };
  } else if (last.content.length > 0) {
    const blocks = last.content.slice();
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock && lastBlock.type === "text") {
      blocks[blocks.length - 1] = { type: "text", text: lastBlock.text, cache_control: { type: "ephemeral" } };
    }
    out[out.length - 1] = { role: "user", content: blocks };
  }
  return out;
}

function isRetryable(err: unknown): boolean {
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
