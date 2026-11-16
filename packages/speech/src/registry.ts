// registry.ts — resolve a voice adapter by provider.
//
// Same rule as the channel registry it mirrors: an unregistered provider is a
// configuration or programming error, never a recoverable one. No default
// provider, no "closest match" — a silent fallback here would make an agent
// speak in a voice nobody chose, billed to a vendor nobody picked (invariant #4).

import { SpeechError } from './errors.ts';
import { googleSpeechAdapter, googleTranscriptionAdapter } from './providers/google.ts';
import { minimaxSpeechAdapter } from './providers/minimax.ts';
import {
  openaiCompatibleSpeechAdapter,
  openaiCompatibleTranscriptionAdapter,
} from './providers/openai-compatible.ts';
import { openrouterSpeechAdapter, openrouterTranscriptionAdapter } from './providers/openrouter.ts';
import type { SpeechAdapter, SpeechProvider, TranscriptionAdapter } from './speech-adapter.ts';

const speechAdapters: ReadonlyMap<SpeechProvider, SpeechAdapter> = new Map([
  ['google', googleSpeechAdapter],
  ['minimax', minimaxSpeechAdapter],
  ['openrouter', openrouterSpeechAdapter],
  ['openai-compatible', openaiCompatibleSpeechAdapter],
]);

const transcriptionAdapters: ReadonlyMap<SpeechProvider, TranscriptionAdapter> = new Map([
  ['google', googleTranscriptionAdapter],
  ['openrouter', openrouterTranscriptionAdapter],
  ['openai-compatible', openaiCompatibleTranscriptionAdapter],
]);

/** Providers that can SPEAK. Not every provider does both — MiniMax synthesises
 *  and does not transcribe — so the two lists are separate and a UI offering a
 *  voice picker asks this one. (OpenRouter speaks since its text-to-speech
 *  models of 2026-09-23: see providers/openrouter.ts.) */
export function speechProviders(): readonly SpeechProvider[] {
  return [...speechAdapters.keys()];
}

/** Providers that can LISTEN. */
export function transcriptionProviders(): readonly SpeechProvider[] {
  return [...transcriptionAdapters.keys()];
}

export function getSpeechAdapter(provider: SpeechProvider): SpeechAdapter {
  const adapter = speechAdapters.get(provider);
  if (!adapter) {
    throw new SpeechError(
      'speech_provider_not_found',
      `speech_provider_not_found: no SpeechAdapter registered for "${provider}" ` +
        `(registered: ${speechProviders().join(', ') || 'none'})`,
    );
  }
  return adapter;
}

export function getTranscriptionAdapter(provider: SpeechProvider): TranscriptionAdapter {
  const adapter = transcriptionAdapters.get(provider);
  if (!adapter) {
    throw new SpeechError(
      'speech_provider_not_found',
      `speech_provider_not_found: no TranscriptionAdapter registered for "${provider}" ` +
        `(registered: ${transcriptionProviders().join(', ') || 'none'})`,
    );
  }
  return adapter;
}
