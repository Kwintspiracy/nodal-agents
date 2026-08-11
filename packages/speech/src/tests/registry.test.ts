import { describe, it, expect } from 'vitest';
import {
  getSpeechAdapter,
  getTranscriptionAdapter,
  speechProviders,
  transcriptionProviders,
} from '../registry.ts';
import { SpeechError } from '../errors.ts';

describe('registry — fail loud, never a default provider', () => {
  it('resolves google for both halves of the loop', () => {
    expect(getSpeechAdapter('google').provider).toBe('google');
    expect(getTranscriptionAdapter('google').provider).toBe('google');
  });

  it('throws speech_provider_not_found for a provider with no adapter', () => {
    // minimax is a declared provider with no adapter yet. Returning "the other
    // one" here would make an agent speak in a voice nobody chose, billed to a
    // vendor nobody picked (invariant #4).
    const err = (() => {
      try {
        getSpeechAdapter('minimax');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SpeechError);
    expect((err as SpeechError).code).toBe('speech_provider_not_found');
    // The message names what IS registered — the first question anyone asks.
    expect((err as SpeechError).message).toContain('google');
  });

  it('lists the two capabilities separately', () => {
    // Not every vendor does both: MiniMax synthesises and does not transcribe.
    // One merged list would offer a listening provider that cannot listen.
    expect([...speechProviders()]).toEqual(['google']);
    expect([...transcriptionProviders()]).toEqual(['google']);
  });

  it('every listed provider actually resolves', () => {
    for (const p of speechProviders()) expect(getSpeechAdapter(p).provider).toBe(p);
    for (const p of transcriptionProviders()) expect(getTranscriptionAdapter(p).provider).toBe(p);
  });
});
