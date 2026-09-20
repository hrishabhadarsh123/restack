/**
 * Provider selection: explicit --provider flag > environment detection.
 * Owns per-provider env vars, default models, and the client factory used
 * by the CLI. Detection order matches PROVIDER_IDS (anthropic first, for
 * backward compatibility with the original single-provider CLI).
 */
import { logger } from "../util/logger.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
import { GeminiClient } from "./google.js";
import type { ModelClient, ProviderId } from "./types.js";

export * from "./types.js";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "google"];

export interface ProviderInfo {
  /** Env keys checked in order — first set wins. */
  keys: string[];
  label: string;
  defaultModel: string;
}

export const PROVIDER_ENV: Record<ProviderId, ProviderInfo> = {
  anthropic: { keys: ["ANTHROPIC_API_KEY"], label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-5" },
  openai: {
    keys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    label: "OpenAI / OpenRouter (GPT)",
    defaultModel: "gpt-5.2",
  },
  google: { keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], label: "Google (Gemini)", defaultModel: "gemini-3-pro" },
};

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: PROVIDER_ENV.anthropic.defaultModel,
  openai: PROVIDER_ENV.openai.defaultModel,
  google: PROVIDER_ENV.google.defaultModel,
};

export interface ProviderSelection {
  id: ProviderId;
  apiKey: string;
  /** Endpoint override (OpenRouter or any OpenAI-compatible gateway). */
  baseURL?: string;
}

/** Env lookup for one provider. Empty-string keys are treated as unset. */
export function resolveProviderEnv(id: ProviderId): ProviderSelection | null {
  for (const key of PROVIDER_ENV[id].keys) {
    const value = process.env[key];
    if (value) {
      if (id === "openai" && key === "OPENROUTER_API_KEY") {
        return {
          id,
          apiKey: value,
          baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        };
      }
      return { id, apiKey: value };
    }
  }
  return null;
}

/** Auto-detect: first provider with any key set, in PROVIDER_IDS order. */
export function detectProvider(): ProviderSelection | null {
  for (const id of PROVIDER_IDS) {
    const sel = resolveProviderEnv(id);
    if (sel) return sel;
  }
  return null;
}

/**
 * Resolve the provider from an explicit --provider flag, falling back to
 * env detection. Returns null (after logging an actionable message) when
 * nothing usable is found — the CLI exits 1, mirroring the original
 * ANTHROPIC_API_KEY contract.
 */
export function selectProvider(explicit?: string): ProviderSelection | null {
  if (explicit != null && !PROVIDER_IDS.includes(explicit as ProviderId)) {
    logger.error(`Unknown provider "${explicit}". Use one of: ${PROVIDER_IDS.join(", ")}.`);
    return null;
  }
  const ids = explicit ? [explicit as ProviderId] : PROVIDER_IDS;
  for (const id of ids) {
    const sel = resolveProviderEnv(id);
    if (sel) return sel;
  }
  logger.error("No model provider key found. Set one of:");
  for (const id of PROVIDER_IDS) {
    const info = PROVIDER_ENV[id];
    logger.error(`  ${info.keys.join(" or ")}  →  ${info.label} (default model: ${info.defaultModel})`);
  }
  logger.info("OpenAI-compatible endpoints (OpenRouter, Groq, Together, Ollama, ...) also work:");
  logger.info("  export OPENAI_API_KEY=...  and  OPENAI_BASE_URL=https://openrouter.ai/api/v1");
  logger.info("Or pass --provider anthropic|openai|google after exporting the matching key.");
  return null;
}

/** Create the concrete client for a selection. */
export function createClient(sel: ProviderSelection, model: string): ModelClient {
  switch (sel.id) {
    case "anthropic":
      return new AnthropicClient(sel.apiKey, model);
    case "openai":
      return new OpenAIClient(sel.apiKey, model, { baseURL: sel.baseURL });
    case "google":
      return new GeminiClient(sel.apiKey, model);
  }
}

/** Warn when a --model value clearly belongs to another provider. */
export function warnModelMismatch(sel: ProviderSelection, model: string): void {
  const families: Record<ProviderId, RegExp> = {
    anthropic: /^claude/i,
    openai: /^(gpt|o\d)/i,
    google: /^gemini/i,
  };
  if (!families[sel.id].test(model)) {
    logger.warn(`Model "${model}" does not look like a ${sel.id} model — pass --provider explicitly if this is intended.`);
  }
}
