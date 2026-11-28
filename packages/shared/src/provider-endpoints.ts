// @nodal-agents/shared — where a model key is sent.
//
// ONE table, read by every place that needs to know where a provider is
// reached: the model clients of `@nodal-agents/llm` (every model call of the
// runner, the conformance CLI, the bench), the dashboard's connection test and
// model list, and the provider screens that show the address. It lives here,
// not in `@nodal-agents/llm`, because the dashboard's client components read it
// too and `@nodal-agents/llm` is server-only.
//
// The rule it serves: the destination of a model call is the address Nodal has
// stored for the key, or, when none is stored, the provider's official address
// written below. Nothing else decides it: the official provider SDKs fall back
// to process environment variables when no base URL is passed, so the clients
// always pass one (`resolveProviderEndpoint` in `@nodal-agents/llm`).

/** Every provider a model key can be saved for. */
export const MODEL_PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'ollama',
  'openai-compatible',
  'google',
  'mistral',
  'groq',
  'openrouter',
  'deepseek',
  'minimax',
  'moonshot',
] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export interface ProviderEndpointSpec {
  /**
   * The provider's official address, used when the key's row stores none.
   * `null`: the provider has no official address (a server the person runs),
   * so a row without one is refused.
   */
  officialBaseUrl: string | null;
  /** Whether a call without a stored key is refused (every hosted provider). */
  keyRequired: boolean;
}

export const PROVIDER_ENDPOINTS: Readonly<Record<ModelProviderName, ProviderEndpointSpec>> = {
  anthropic: { officialBaseUrl: 'https://api.anthropic.com/v1', keyRequired: true },
  openai: { officialBaseUrl: 'https://api.openai.com/v1', keyRequired: true },
  google: {
    officialBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyRequired: true,
  },
  mistral: { officialBaseUrl: 'https://api.mistral.ai/v1', keyRequired: true },
  groq: { officialBaseUrl: 'https://api.groq.com/openai/v1', keyRequired: true },
  openrouter: { officialBaseUrl: 'https://openrouter.ai/api/v1', keyRequired: true },
  deepseek: { officialBaseUrl: 'https://api.deepseek.com/v1', keyRequired: true },
  // MiniMax's Anthropic Messages-compatible endpoint (native protocol).
  minimax: { officialBaseUrl: 'https://api.minimax.io/anthropic', keyRequired: true },
  // Global endpoint. The China-region host (api.moonshot.cn/v1) is reached by
  // storing it on the key's row.
  moonshot: { officialBaseUrl: 'https://api.moonshot.ai/v1', keyRequired: true },
  // Ollama's documented default address on the person's own machine.
  ollama: { officialBaseUrl: 'http://localhost:11434', keyRequired: false },
  // A server the person runs (LM Studio, Jan, llama.cpp, vLLM…): no official
  // address, the row must store one.
  'openai-compatible': { officialBaseUrl: null, keyRequired: false },
};

export function isModelProviderName(value: string): value is ModelProviderName {
  return (MODEL_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * The address a key of `provider` is sent to: the stored one (trailing slashes
 * removed), else the provider's official address, else `null` (nothing to send
 * to: the caller refuses, it never guesses).
 */
export function providerDestination(
  provider: ModelProviderName,
  storedBaseUrl: string | null | undefined,
): string | null {
  const stored = (storedBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (stored.length > 0) return stored;
  return PROVIDER_ENDPOINTS[provider].officialBaseUrl;
}
