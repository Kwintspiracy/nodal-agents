// model-provider-detect.ts — pure helpers that infer which LLM provider a
// given model identifier expects.
//
// Used by AgentForm to warn the user when their selected llm_key (provider X)
// is incompatible with the typed model string (which "looks like" provider Y).
// Live bug encountered: an agent had model "deepseek/deepseek-v4-flash" but
// llm_key_id pointed at a Claude key — runtime failed silently with a
// truncated "model: <id>" error.

export type ProviderSlug =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'openai-compatible';

/** Providers that accept arbitrary model identifiers (no naming convention). */
const LOCAL_PROVIDERS: ReadonlySet<ProviderSlug> = new Set(['ollama', 'openai-compatible']);

/**
 * Infer which providers can host the given model id.
 *
 * Returns an empty set when the model is unrecognized — in that case the
 * caller should treat it as "could be anything" rather than as a failure
 * (don't false-flag a custom or local model the heuristic doesn't know).
 *
 * A model with a `/` (e.g. `deepseek/deepseek-v4-flash`) is treated as
 * OpenRouter-style routing — OpenRouter uses `vendor/model` slugs everywhere.
 */
export function detectModelProviders(model: string): Set<ProviderSlug> {
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0) return new Set();

  const out = new Set<ProviderSlug>();

  // `vendor/model` is the OpenRouter signature.
  if (trimmed.includes('/')) {
    out.add('openrouter');
    return out;
  }

  if (trimmed.startsWith('claude')) {
    out.add('anthropic');
    return out;
  }

  if (
    trimmed.startsWith('gpt') ||
    trimmed.startsWith('chatgpt') ||
    /^o[134](?:[-_]|$)/.test(trimmed)
  ) {
    out.add('openai');
    return out;
  }

  if (trimmed.startsWith('gemini')) {
    out.add('google');
    return out;
  }

  // gemma is Google's open-weight family — usually run locally via LM Studio
  // or Ollama. Don't pin to 'google' since most users hit it through the
  // openai-compatible local stack.
  if (trimmed.startsWith('gemma')) {
    out.add('google');
    out.add('ollama');
    out.add('openai-compatible');
    return out;
  }

  if (
    trimmed.startsWith('mistral') ||
    trimmed.startsWith('codestral') ||
    trimmed.startsWith('pixtral') ||
    trimmed.startsWith('magistral') ||
    trimmed.startsWith('ministral') ||
    trimmed.startsWith('mixtral')
  ) {
    out.add('mistral');
    return out;
  }

  // Llama / Qwen / DeepSeek without a `/` prefix typically means local
  // (LM Studio, Ollama). Don't lock them to a single provider.
  if (trimmed.startsWith('llama') || trimmed.startsWith('qwen') || trimmed.startsWith('deepseek')) {
    out.add('ollama');
    out.add('openai-compatible');
    out.add('groq');
    return out;
  }

  // Unknown — don't warn.
  return out;
}

/**
 * Returns true when the model id is plausibly served by the given provider.
 *
 * Conservative on purpose:
 *   - Empty model or no-detection → compatible (don't false-positive).
 *   - Local providers (ollama / openai-compatible) → always compatible
 *     (they can host any model id).
 *   - OpenRouter → compatible only if the model contains `/`, OR if the
 *     detection set already includes 'openrouter'.
 */
export function isModelCompatibleWithProvider(model: string, provider: ProviderSlug): boolean {
  if (model.trim().length === 0) return true;
  if (LOCAL_PROVIDERS.has(provider)) return true;

  const candidates = detectModelProviders(model);
  if (candidates.size === 0) return true;
  return candidates.has(provider);
}
