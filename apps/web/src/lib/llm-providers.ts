import 'server-only';
import { env } from './env.ts';
import { prettyProviderName } from './provider-names.ts';

export interface ConfiguredLlmProvider {
  /** Stable identifier (used as form value) — e.g., 'lm-studio:google/gemma-4-31b' */
  id: string;
  /** Provider slug from env (e.g., 'openai-compatible', 'anthropic') */
  providerSlug: string;
  /** The model name passed to the LLM API (stored in agents.model) */
  model: string;
  /** Human-readable label for the dropdown — e.g., 'LM Studio · google/gemma-4-31b' */
  label: string;
}

/**
 * Return the list of LLM providers available to the user.
 * For MVT this is the single provider configured at `nodalai init` (read from
 * env vars LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL passed by the CLI).
 *
 * Post-MVT: this will read the user's saved provider configs from the DB
 * (Settings UI for adding multiple providers), and merge with the env-default.
 */
export function getConfiguredLlmProviders(): ConfiguredLlmProvider[] {
  const providerSlug = env.LLM_PROVIDER;
  const model = env.LLM_MODEL;
  if (!providerSlug || !model) return [];

  return [
    {
      id: `${providerSlug}:${model}`,
      providerSlug,
      model,
      label: `${prettyProviderName(providerSlug)} · ${model}`,
    },
  ];
}
