/**
 * Multi-provider support: env detection, per-provider defaults, pricing
 * entries, and provider-specific request/usage mapping — all without
 * touching the network (OpenAI is tested through an injected fetch).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  DEFAULT_MODELS,
  detectProvider,
  selectProvider,
  warnModelMismatch,
} from "../src/providers/index.js";
import { AnthropicClient } from "../src/providers/anthropic.js";
import { GeminiClient, geminiUsage } from "../src/providers/google.js";
import { isReasoningModel, OpenAIClient, openAIUsage } from "../src/providers/openai.js";
import type { ProviderSelection } from "../src/providers/index.js";
import { pricingFor } from "../src/util/tokens.js";
import { logger } from "../src/util/logger.js";

const ALL_PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_BASE_URL",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Force every provider key to the empty string (= unset for detection). */
function clearProviderEnv(): void {
  for (const k of ALL_PROVIDER_KEYS) vi.stubEnv(k, "");
}

describe("provider detection", () => {
  it("detects anthropic from ANTHROPIC_API_KEY", () => {
    clearProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(detectProvider()?.id).toBe("anthropic");
  });

  it("detects openai and google from their keys", () => {
    clearProviderEnv();
    vi.stubEnv("OPENAI_API_KEY", "sk-oai");
    expect(detectProvider()?.id).toBe("openai");
    clearProviderEnv();
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    expect(detectProvider()?.id).toBe("google");
    clearProviderEnv();
    vi.stubEnv("GOOGLE_API_KEY", "g-test");
    expect(detectProvider()?.id).toBe("google");
  });

  it("treats OPENROUTER_API_KEY as the openai provider with its base URL", () => {
    clearProviderEnv();
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
    const sel = detectProvider();
    expect(sel?.id).toBe("openai");
    expect(sel?.baseURL).toBe("https://openrouter.ai/api/v1");
    vi.stubEnv("OPENROUTER_BASE_URL", "https://proxy.example.com/v1");
    expect(detectProvider()?.baseURL).toBe("https://proxy.example.com/v1");
  });

  it("ignores empty-string keys", () => {
    clearProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "g-test");
    expect(detectProvider()?.id).toBe("google");
  });

  it("prefers anthropic > openai > google when several keys are set", () => {
    clearProviderEnv();
    vi.stubEnv("OPENAI_API_KEY", "o");
    vi.stubEnv("GEMINI_API_KEY", "g");
    expect(detectProvider()?.id).toBe("openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "a");
    expect(detectProvider()?.id).toBe("anthropic");
  });

  it("returns null with guidance listing every provider when no key is set", () => {
    clearProviderEnv();
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    expect(selectProvider()).toBeNull();
    const all = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).toContain("ANTHROPIC_API_KEY");
    expect(all).toContain("OPENAI_API_KEY");
    expect(all).toContain("GEMINI_API_KEY");
    expect(infoSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("rejects unknown --provider values", () => {
    clearProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "a");
    const errSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    expect(selectProvider("mistral")).toBeNull();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join(" ")).toContain("Unknown provider");
  });

  it("respects an explicit --provider even when another key is present", () => {
    clearProviderEnv();
    vi.stubEnv("ANTHROPIC_API_KEY", "a");
    vi.stubEnv("OPENAI_API_KEY", "o");
    expect(selectProvider("openai")?.id).toBe("openai");
  });
});

describe("defaults and factory", () => {
  it("has a sensible default model per provider", () => {
    expect(DEFAULT_MODELS.anthropic).toMatch(/^claude/);
    expect(DEFAULT_MODELS.openai).toMatch(/^gpt/);
    expect(DEFAULT_MODELS.google).toMatch(/^gemini/);
  });

  it("creates the right client class per provider", () => {
    expect(createClient({ id: "anthropic", apiKey: "k" }, "claude-sonnet-4-5")).toBeInstanceOf(AnthropicClient);
    expect(createClient({ id: "openai", apiKey: "k" }, "gpt-5.1")).toBeInstanceOf(OpenAIClient);
    expect(createClient({ id: "google", apiKey: "k" }, "gemini-3-pro")).toBeInstanceOf(GeminiClient);
  });

  it("warns only on model/provider family mismatch", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const openai: ProviderSelection = { id: "openai", apiKey: "k" };
    warnModelMismatch(openai, "claude-sonnet-4-5");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnModelMismatch(openai, "gpt-5.1");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("multi-provider pricing", () => {
  it("matches explicit and prefix model ids", () => {
    expect(pricingFor("gpt-5.2").outputPerMillion).toBe(14);
    expect(pricingFor("gpt-5.2-2026-01-15").inputPerMillion).toBe(1.75);
    expect(pricingFor("gpt-5.4").outputPerMillion).toBe(10); // gpt-5 catch-all
    expect(pricingFor("gemini-3.1-pro-preview").outputPerMillion).toBe(12); // gemini-3 catch-all
    expect(pricingFor("gemini-3-flash").inputPerMillion).toBe(0.5);
    expect(pricingFor("claude-sonnet-4-5").contextWindow).toBe(200_000);
  });

  it("matches OpenRouter-style vendor-prefixed ids on the bare model name", () => {
    expect(pricingFor("openai/gpt-5.1").outputPerMillion).toBe(10);
    expect(pricingFor("anthropic/claude-sonnet-4-5").contextWindow).toBe(200_000);
    expect(pricingFor("google/gemini-3-pro").contextWindow).toBe(1_000_000);
  });

  it("gives non-Claude providers their real context windows for packing", () => {
    expect(pricingFor("gpt-5.1").contextWindow).toBe(400_000);
    expect(pricingFor("gemini-3-pro").contextWindow).toBe(1_000_000);
  });
});

describe("isReasoningModel", () => {
  it("classifies reasoning vs classic chat models", () => {
    expect(isReasoningModel("gpt-5.1")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("gpt-4.1")).toBe(false);
  });
});

describe("OpenAIClient", () => {
  function fakeChat(body: Record<string, unknown>): { fetch: typeof fetch; body: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    const f = (async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? "{}");
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 700 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { fetch: f, body: () => captured };
  }

  it("sends the system prompt and reasoning params; maps usage incl. cached tokens", async () => {
    const fake = fakeChat({ model: "gpt-5.1" });
    const client = new OpenAIClient("k", "gpt-5.1", { fetch: fake.fetch });
    const res = await client.call({
      model: "gpt-5.1",
      maxTokens: 1234,
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      cacheLastUserBlock: true, // ignored: caching is automatic server-side
      maxRetries: 0,
    });

    const body = fake.body();
    expect(res.text).toBe("OK");
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.max_completion_tokens).toBe(1234);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();

    expect(client.calls).toBe(1);
    expect(client.inputTokens).toBe(1000);
    expect(client.outputTokens).toBe(200);
    expect(res.usage.cache_read_input_tokens).toBe(700);
    // 300 uncached × $1.25/M + 700 cached × $0.125/M + 200 out × $10/M
    expect(res.costUsd).toBeCloseTo(0.000375 + 0.0000875 + 0.002, 6);
    expect(client.usd).toBeCloseTo(res.costUsd, 6);
  });

  it("uses max_tokens + temperature for classic models", async () => {
    const fake = fakeChat({ model: "gpt-4o" });
    const client = new OpenAIClient("k", "gpt-4o", { fetch: fake.fetch });
    await client.call({
      model: "gpt-4o",
      maxTokens: 500,
      system: "S",
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 0,
    });
    const body = fake.body();
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("openAIUsage handles missing payloads", () => {
    expect(openAIUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("gemini usage mapping", () => {
  it("bills thoughts as output and maps cached reads", () => {
    const u = geminiUsage({
      promptTokenCount: 5000,
      candidatesTokenCount: 800,
      thoughtsTokenCount: 300,
      cachedContentTokenCount: 2000,
    });
    expect(u.input_tokens).toBe(5000);
    expect(u.output_tokens).toBe(1100);
    expect(u.cache_read_input_tokens).toBe(2000);
    expect(geminiUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
