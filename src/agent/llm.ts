import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Provider-agnostic chat-model factory.
 *
 * The rest of the agent only ever depends on LangChain's `BaseChatModel`
 * interface, so swapping providers is a config change. Provider SDKs are
 * optional dependencies and imported lazily — the app still runs (rule engine
 * only) if none are installed or no API key is set.
 */
export type LlmProvider = "anthropic" | "openai" | "ollama";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  temperature?: number;
  apiKey?: string;
  /** Base URL for self-hosted providers (Ollama). */
  baseUrl?: string;
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** Resolve config from environment. Returns null when no provider is usable. */
export function llmConfigFromEnv(): LlmConfig | null {
  const provider = (process.env.PS_AGENT_LLM_PROVIDER as LlmProvider | undefined) ?? undefined;

  if (provider === "anthropic" || (!provider && process.env.ANTHROPIC_API_KEY)) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    return {
      provider: "anthropic",
      model: process.env.PS_AGENT_LLM_MODEL ?? "claude-3-5-sonnet-latest",
      temperature: envNumber("PS_AGENT_LLM_TEMPERATURE", 0),
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  if (provider === "openai" || (!provider && process.env.OPENAI_API_KEY)) {
    if (!process.env.OPENAI_API_KEY) return null;
    return {
      provider: "openai",
      model: process.env.PS_AGENT_LLM_MODEL ?? "gpt-4o-mini",
      temperature: envNumber("PS_AGENT_LLM_TEMPERATURE", 0),
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  // Ollama (local): no API key, so it's only used when explicitly selected via
  // PS_AGENT_LLM_PROVIDER=ollama (optionally with a model/base URL).
  if (provider === "ollama") {
    const model = process.env.PS_AGENT_LLM_MODEL ?? process.env.OLLAMA_MODEL;
    if (!model) return null; // require an explicit model for local
    return {
      provider: "ollama",
      model,
      temperature: envNumber("PS_AGENT_LLM_TEMPERATURE", 0),
      baseUrl: process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    };
  }

  return null;
}

/** Build a chat model from config. Throws if the provider SDK is missing. */
export async function createChatModel(config: LlmConfig): Promise<BaseChatModel> {
  switch (config.provider) {
    case "anthropic": {
      const mod = await importOptional("@langchain/anthropic");
      const { ChatAnthropic } = mod as typeof import("@langchain/anthropic");
      return new ChatAnthropic({
        model: config.model,
        temperature: config.temperature ?? 0,
        apiKey: config.apiKey,
      });
    }
    case "openai": {
      const mod = await importOptional("@langchain/openai");
      const { ChatOpenAI } = mod as typeof import("@langchain/openai");
      return new ChatOpenAI({
        model: config.model,
        temperature: config.temperature ?? 0,
        apiKey: config.apiKey,
      });
    }
    case "ollama": {
      const mod = await importOptional("@langchain/ollama");
      const { ChatOllama } = mod as typeof import("@langchain/ollama");
      return new ChatOllama({
        model: config.model,
        temperature: config.temperature ?? 0,
        baseUrl: config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      });
    }
  }
}

/** Convenience: resolve from env and build, or return null if unavailable. */
export async function createChatModelFromEnv(): Promise<BaseChatModel | null> {
  const config = llmConfigFromEnv();
  if (!config) return null;
  try {
    return await createChatModel(config);
  } catch {
    return null;
  }
}

async function importOptional(name: string): Promise<unknown> {
  try {
    return await import(name);
  } catch {
    throw new Error(
      `LLM provider package "${name}" is not installed. Run: npm install ${name}`,
    );
  }
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
