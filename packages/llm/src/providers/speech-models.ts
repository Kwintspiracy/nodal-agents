// @nodal-agents/llm — speech generation (text in, audio file out) (#487).
//
// Twin of image-models.ts for the AI SDK's SPEECH models. OpenRouter serves
// text-to-speech on `POST /api/v1/audio/speech`, compatible with OpenAI's
// Audio Speech API, so the installed @ai-sdk/openai speech model pointed at
// OpenRouter's base URL does the call (the OpenRouter provider for the AI SDK
// has no speech model). The entity's existing OpenRouter key is reused.
//
// Gemini 3.8 TTS reads `input` verbatim: a delivery direction written into the
// text is spoken aloud. OpenRouter takes the style as
// `provider.options["google-ai-studio"].speech_metadata.style` instead
// (docs: guides/overview/multimodal/tts, "Google (Gemini TTS)"). The AI SDK's
// OpenAI speech model sends a fixed set of fields, so the style is added to the
// request body on its way out, through the `fetch` the provider accepts.

import { createOpenAI } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { PROVIDER_PRESETS } from './registry';
import { ProviderConfigError } from '../errors';

export interface SpeechRequest {
  /** OpenRouter model id, e.g. `google/gemini-3.8-flash-tts`. */
  model: string;
  text: string;
  voice: string;
  /** A sustained delivery style ("warm and friendly", "whispering"). Never read aloud. */
  style?: string;
}

/** The audio as raw bytes: the caller writes it where it belongs. */
export interface GeneratedSpeech {
  bytes: Uint8Array;
  mediaType: string;
}

export type SpeechGenerator = (request: SpeechRequest) => Promise<GeneratedSpeech>;

/** Adds the Gemini delivery style to an `/audio/speech` request body. */
export function withGeminiStyle(body: string, style: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  // Merged, never replaced: a routing field already in `provider` stays
  // (review of PR #488).
  const provider = (parsed['provider'] ?? {}) as Record<string, unknown>;
  const options = (provider['options'] ?? {}) as Record<string, unknown>;
  const google = (options['google-ai-studio'] ?? {}) as Record<string, unknown>;
  parsed['provider'] = {
    ...provider,
    options: {
      ...options,
      'google-ai-studio': { ...google, speech_metadata: { style } },
    },
  };
  return JSON.stringify(parsed);
}

/**
 * A speech generator on OpenRouter for one API key (already decrypted by the
 * caller). mp3 only for now: OpenRouter offers mp3 or raw pcm, and a raw pcm
 * file is not playable as is.
 */
export function createOpenRouterSpeech(
  apiKey: string,
  opts: { baseURL?: string; fetch?: typeof fetch } = {},
): SpeechGenerator {
  if (!apiKey) throw new ProviderConfigError('openrouter speech requires an apiKey');
  const baseURL = opts.baseURL ?? PROVIDER_PRESETS.openrouter.defaultBaseURL;
  const send = opts.fetch ?? fetch;

  return async (request) => {
    const styled =
      request.style !== undefined &&
      request.style.trim() !== '' &&
      request.model.startsWith('google/')
        ? request.style.trim()
        : undefined;
    const provider = createOpenAI({
      apiKey,
      baseURL,
      fetch: async (url, init) => {
        if (styled !== undefined && typeof init?.body === 'string') {
          return send(url, { ...init, body: withGeminiStyle(init.body, styled) });
        }
        return send(url, init);
      },
    });
    const result = await generateSpeech({
      model: provider.speech(request.model),
      text: request.text,
      voice: request.voice,
      outputFormat: 'mp3',
      maxRetries: 0,
    });
    return { bytes: result.audio.uint8Array, mediaType: result.audio.mediaType };
  };
}
