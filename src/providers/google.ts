/**
 * Google Gemini provider via the official @google/genai SDK.
 * Key: GEMINI_API_KEY (or GOOGLE_API_KEY).
 *
 * Notes:
 * - Chat turns map user -> "user", assistant -> "model" (Gemini's roles).
 * - Thinking budgets: thoughtsTokenCount is billed as output, so it is
 *   added to output_tokens for cost accounting.
 * - Implicit caching (cachedContentTokenCount) maps to cache reads.
 */
import { GoogleGenAI } from "@google/genai";
import { pricingFor, usageCost, type ModelPricing, type UsageLike } from "../util/tokens.js";
import { withRetries } from "../util/retry.js";
import { logger } from "../util/logger.js";
import type { CallOptions, CallResult, ModelClient, ProviderId } from "./types.js";

export class GeminiClient implements ModelClient {
  readonly provider: ProviderId = "google";
  readonly model: string;
  private client: GoogleGenAI;
  readonly pricing: ModelPricing;

  // Aggregate accounting
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;

  constructor(apiKey: string, model: string) {
    this.model = model;
    this.client = new GoogleGenAI({ apiKey });
    this.pricing = pricingFor(model);
  }

  async call(opts: CallOptions): Promise<CallResult> {
    const resp = await withRetries(
      () =>
        this.client.models.generateContent({
          model: opts.model,
          contents: opts.messages.map((m) => ({
            role: m.role === "assistant" ? ("model" as const) : ("user" as const),
            parts: [{ text: m.content }],
          })),
          config: {
            systemInstruction: opts.system,
            maxOutputTokens: opts.maxTokens,
            temperature: opts.temperature ?? 0,
          },
        }),
      { maxRetries: opts.maxRetries, label: opts.label },
    );

    this.calls++;
    const usage = geminiUsage(resMeta(resp));
    const cost = usageCost(this.pricing, usage);
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.usd += cost;

    const text = resp.text ?? "";
    const finish = resp.candidates?.[0]?.finishReason;

    logger.debug(
      `[api/gemini] ${opts.label ?? "call"}: in=${usage.input_tokens} out=${usage.output_tokens} cost=$${cost.toFixed(4)} stop=${finish ?? "null"}`,
    );

    return {
      text,
      usage,
      costUsd: cost,
      stopReason: finish ?? null,
      model: opts.model,
    };
  }
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

function resMeta(resp: { usageMetadata?: GeminiUsageMetadata }): GeminiUsageMetadata | undefined {
  return resp.usageMetadata;
}

/** Map Gemini usageMetadata onto our UsageLike shape. */
export function geminiUsage(u: GeminiUsageMetadata | undefined): UsageLike {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const usage: UsageLike = {
    input_tokens: u.promptTokenCount ?? 0,
    output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
  if (u.cachedContentTokenCount) usage.cache_read_input_tokens = u.cachedContentTokenCount;
  return usage;
}
