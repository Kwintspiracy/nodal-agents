// @nodal-agents/llm — image-model builders.
//
// Mirrors the language-model builders (anthropic.ts, openrouter.ts, …) but for
// the AI SDK's IMAGE models: given a resolved ProviderConfig (provider + model +
// decrypted apiKey + optional baseURL), return an `ImageModel` ready for the
// SDK's `generateImage()`. Media generation reuses the entity's existing
// provider keys (same entity_llm_keys row), so no new credential type is needed.
//
// Phase 1 providers: OpenAI (gpt-image / dall-e) and OpenRouter (Flux, Seedream,
// and aggregated routes incl. Google/Nano Banana where listed). Native Google
// image and fal/replicate are follow-up provider additions (the installed
// @ai-sdk/google has no imageModel(); @ai-sdk/fal is not installed yet).

import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateImage } from 'ai';
import type { ImageModel } from 'ai';
import type { ProviderConfig } from '../types';
import { PROVIDER_PRESETS } from './registry';
import { ProviderConfigError } from '../errors';

/** Providers that expose image models through their installed AI SDK adapter. */
export const IMAGE_CAPABLE_PROVIDERS = ['openai', 'openrouter'] as const;

/** A generated image as raw bytes — the caller persists it (workspace, artifact store…). */
export interface GeneratedImage {
  base64: string;
  mediaType: string;
}

export function buildImageModel(config: ProviderConfig): ImageModel {
  if (!config.apiKey) {
    throw new ProviderConfigError(`${config.provider} image provider requires an apiKey`);
  }

  switch (config.provider) {
    case 'openai': {
      const provider = createOpenAI({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
      return provider.imageModel(config.model);
    }
    case 'openrouter': {
      const baseURL = config.baseURL ?? PROVIDER_PRESETS.openrouter.defaultBaseURL;
      const provider = createOpenRouter({ apiKey: config.apiKey, baseURL });
      return provider.imageModel(config.model);
    }
    default:
      throw new ProviderConfigError(
        `provider '${config.provider}' has no image-model support (image-capable: ${IMAGE_CAPABLE_PROVIDERS.join(', ')})`,
      );
  }
}

/**
 * High-level image generation: build the provider's image model and call the AI
 * SDK's generateImage. Keeps the AI SDK inside @nodal-agents/llm so callers
 * (tools via the runner's provisioning) stay dependency-light. `config.apiKey`
 * must already be decrypted by the caller.
 */
export async function generateImageWithProvider(
  config: ProviderConfig,
  opts: { prompt: string; size?: `${number}x${number}`; n?: number },
): Promise<GeneratedImage[]> {
  const model = buildImageModel(config);
  const result = await generateImage({
    model,
    prompt: opts.prompt,
    ...(opts.n ? { n: opts.n } : {}),
    ...(opts.size ? { size: opts.size } : {}),
  });
  return result.images.map((f) => ({ base64: f.base64, mediaType: f.mediaType }));
}
