import { AnthropicSession } from "./anthropic";
import { GeminiSession } from "./gemini";
import { loadFixture, ReplaySession } from "./replay";
import type { ChatSession, ProviderName, SessionConfig } from "./types";

export function isReplay(): boolean {
  return /^(1|true|yes)$/i.test(process.env.REPLAY ?? "");
}

/** REPLAY=1 wins over LLM_PROVIDER, so the UI and tests never touch a real API by accident. */
export function resolveProvider(value = process.env.LLM_PROVIDER): ProviderName {
  if (isReplay()) return "replay";
  const v = (value ?? "anthropic").trim().toLowerCase();
  if (v === "anthropic" || v === "gemini") return v;
  throw new Error(`Unsupported LLM_PROVIDER "${value}". Use "anthropic" or "gemini".`);
}

export function createSession(provider: ProviderName, cfg: SessionConfig): ChatSession {
  if (provider === "replay") return new ReplaySession(loadFixture(), cfg.history);
  return provider === "gemini" ? new GeminiSession(cfg) : new AnthropicSession(cfg);
}

/** Name of the env var holding the provider's API key, for setup errors. */
export function missingCredential(provider: ProviderName): string | undefined {
  if (provider === "replay") return undefined;
  if (provider === "gemini") return process.env.GEMINI_API_KEY ? undefined : "GEMINI_API_KEY";
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? undefined : "ANTHROPIC_API_KEY";
}

export type { ChatSession, ProviderName, SessionConfig, ToolSpec, ModelTurn, ToolCall, ToolResult, RetryNotice } from "./types";
