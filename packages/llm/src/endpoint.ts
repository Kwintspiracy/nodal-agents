// @nodal-agents/llm — the destination and the credential of a model call
//
// Every provider client of this package is built from `resolveProviderEndpoint`:
// the model clients (every builder of `providers/`), the embedding client and
// the image models. The dashboard's connection test and model list resolve
// their address with the same function, so they reach the address a real call
// reaches.
//
// Why every client receives BOTH values explicitly: when a value is not
// passed, the official SDKs read it from the process environment —
// `loadOptionalSetting` for the base URL (`ANTHROPIC_BASE_URL`,
// `OPENAI_BASE_URL`) and `loadApiKey` for the key (`ANTHROPIC_API_KEY`,
// `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`,
// `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`), see
// `@ai-sdk/provider-utils` `loadApiKey` / `loadOptionalSetting`. Both only
// look at the environment when the option is not a string. Passing a string
// for each closes that door for every provider at once.

import { PROVIDER_ENDPOINTS, providerDestination } from '@nodal-agents/shared';

import { ProviderConfigError } from './errors';
import type { ProviderName } from './types';

export interface ProviderEndpoint {
  /** Where the call goes: the stored address, else the official one. */
  baseURL: string;
  /**
   * The stored key. `undefined` only for a provider that needs none (a server
   * the person runs); every hosted provider has one, or resolution throws.
   */
  apiKey: string | undefined;
}

/**
 * The destination and the credential of a call for `provider`, from what is
 * stored and nothing else.
 *
 * Throws `ProviderConfigError` naming the provider when there is no address
 * to send to (no stored one and no official one) or when a hosted provider has
 * no stored key: a call is never sent with values the caller did not store.
 */
export function resolveProviderEndpoint(input: {
  provider: ProviderName;
  baseURL?: string | null | undefined;
  apiKey?: string | null | undefined;
}): ProviderEndpoint {
  const spec = PROVIDER_ENDPOINTS[input.provider];
  if (!spec) {
    throw new ProviderConfigError(`Unknown provider: ${String(input.provider)}`);
  }
  const baseURL = providerDestination(input.provider, input.baseURL);
  if (baseURL === null) {
    throw new ProviderConfigError(
      `${input.provider} provider requires a baseURL (it has no official address; e.g. http://localhost:1234/v1)`,
    );
  }
  const apiKey = input.apiKey && input.apiKey.length > 0 ? input.apiKey : undefined;
  if (spec.keyRequired && apiKey === undefined) {
    throw new ProviderConfigError(`${input.provider} provider requires an apiKey`);
  }
  return { baseURL, apiKey };
}
