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
 * Gemini TTS answers raw PCM: signed 16-bit little-endian, mono, 24 kHz, as
 * Google documents its speech output. Used when the answer's content type
 * names no rate.
 */
export const GEMINI_TTS_SAMPLE_RATE = 24_000;

/**
 * Raw 16-bit mono PCM wrapped in a WAV (RIFF) header, so any player opens it.
 * No transcoding: the samples are copied as they came.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/**
 * `audio/pcm;rate=16000` → 16000; no rate named → the Gemini default. Only a
 * `rate` PARAMETER counts: `bitrate=64000` is not a sample rate (review of
 * PR #489).
 */
function sampleRateOf(contentType: string): number {
  const match = /(?:^|;)\s*rate=(\d+)/i.exec(contentType);
  return match ? Number(match[1]) : GEMINI_TTS_SAMPLE_RATE;
}

/**
 * A speech generator on OpenRouter for one API key (already decrypted by the
 * caller). The audio comes back as a WAV file: Gemini TTS through OpenRouter
 * only answers `response_format: "pcm"` (it refuses mp3: "Gemini TTS only
 * supports response_format=\"pcm\"", run 16052ae6, 2026-09-25), and raw PCM
 * is not playable as is, so the samples get a WAV header.
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
      outputFormat: 'pcm',
      maxRetries: 0,
    });
    // The AI SDK copies the fetch Headers, whose keys are lower-case.
    const contentType = result.responses[0]?.headers?.['content-type'] ?? '';
    // A 200 whose body is not audio (an error page) is said, never wrapped
    // into a broken file. An answer naming no type at all is taken as the pcm
    // it was asked for: the odd-length check below still catches a cut stream.
    if (contentType !== '' && !/^audio\//i.test(contentType)) {
      throw new Error(`${request.model} answered ${contentType}, not audio`);
    }
    const pcm = result.audio.uint8Array;
    // 16-bit samples come in pairs of bytes: an odd count is a cut stream, and
    // its WAV would be malformed (review of PR #489).
    if (pcm.byteLength % 2 !== 0) {
      throw new Error(
        `${request.model} answered ${pcm.byteLength} bytes of 16-bit audio: an odd count, the stream was cut`,
      );
    }
    return {
      bytes: pcmToWav(pcm, sampleRateOf(contentType)),
      mediaType: 'audio/wav',
    };
  };
}
