// registry.ts — resolve a voice adapter by provider.
//
// Same rule as the channel registry it mirrors: an unregistered provider is a
// configuration or programming error, never a recoverable one. No default
// provider, no "closest match" — a silent fallback here would make an agent
// speak in a voice nobody chose, billed to a vendor nobody picked (invariant #4).

import { SpeechError } from './errors.ts';
import { googleSpeechAdapter, googleTranscriptionAdapter } from './providers/google.ts';
import { minimaxSpeechAdapter } from './providers/minimax.ts';
import { openrouterTranscriptionAdapter } from './providers/openrouter.ts';
import type { SpeechAdapter, SpeechProvider, TranscriptionAdapter } from './speech-adapter.ts';

const speechAdapters: ReadonlyMap<SpeechProvider, SpeechAdapter> = new Map([
  ['google', googleSpeechAdapter],
  ['minimax', minimaxSpeechAdapter],
]);

const transcriptionAdapters: ReadonlyMap<SpeechProvider, TranscriptionAdapter> = new Map([
  ['google', googleTranscriptionAdapter],
  ['openrouter', openrouterTranscriptionAdapter],
]);

/** Providers that can SPEAK. Not every provider does both — MiniMax synthesises
 *  and does not transcribe — so the two lists are separate and a UI offering a
 *  voice picker asks this one. */
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
