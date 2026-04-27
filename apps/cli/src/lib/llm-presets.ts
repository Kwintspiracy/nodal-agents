// llm-presets.ts — preset definitions for each supported LLM provider

import type { LlmProvider } from './config.ts';

export interface LlmPreset {
  provider: LlmProvider;
  label: string;
  defaultBaseURL: string;
  /** Whether an API key is required (remote providers) */
  requiresApiKey: boolean;
  /** Default model name to pre-fill */
  defaultModel: string;
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    provider: 'ollama',
    label: 'Ollama (local)',
    defaultBaseURL: 'http://localhost:11434',
    requiresApiKey: false,
    defaultModel: 'llama3.2',
  },
  {
    provider: 'lm-studio',
    label: 'LM Studio',
    defaultBaseURL: 'http://localhost:1234/v1',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    provider: 'jan-ai',
    label: 'Jan.ai',
    defaultBaseURL: 'http://localhost:1337/v1',
    requiresApiKey: false,
    defaultModel: 'mistral-7b-instruct',
  },
  {
    provider: 'llamacpp',
    label: 'llama.cpp server',
    defaultBaseURL: 'http://localhost:8080/v1',
    requiresApiKey: false,
    defaultModel: 'llama3',
  },
  {
    provider: 'vllm',
    label: 'vLLM',
    defaultBaseURL: 'http://localhost:8000/v1',
    requiresApiKey: false,
    defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
  },
  {
    provider: 'openai-compatible',
    label: 'Custom OpenAI-compatible endpoint',
    defaultBaseURL: 'http://localhost:8080/v1',
    requiresApiKey: false,
    defaultModel: 'local-model',
  },
  {
    provider: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultBaseURL: 'https://api.anthropic.com',
    requiresApiKey: true,
    defaultModel: 'claude-sonnet-4-6-20260217',
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    requiresApiKey: true,
    defaultModel: 'gpt-4o',
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    defaultModel: 'anthropic/claude-3.5-sonnet',
  },
];

export function getPreset(provider: LlmProvider): LlmPreset {
  const preset = LLM_PRESETS.find((p) => p.provider === provider);
  if (!preset) {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  return preset;
}

/**
 * Try to fetch available models from the given base URL.
 * Returns null if the endpoint is not reachable or doesn't expose /v1/models.
 */
export async function fetchModels(
  baseURL: string,
  provider: LlmProvider,
  apiKey?: string,
): Promise<string[] | null> {
  // Anthropic doesn't expose /v1/models in the same way
  if (provider === 'anthropic') return null;

  const url = `${baseURL.replace(/\/$/, '')}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    if (!json.data || !Array.isArray(json.data)) return null;
    return json.data.map((m) => m.id).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Check if a given base URL is reachable (simple HEAD/GET).
 * Returns false on timeout or network error.
 */
export async function isEndpointReachable(
  baseURL: string,
  provider: LlmProvider,
): Promise<boolean> {
  const url =
    provider === 'ollama'
      ? `${baseURL.replace(/\/$/, '')}/api/tags` // Ollama-specific health
      : `${baseURL.replace(/\/$/, '')}/v1/models`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.status < 500;
  } catch {
    return false;
  }
}
