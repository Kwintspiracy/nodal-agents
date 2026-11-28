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
    // Returning "the other one" here would make an agent speak in a voice
    // nobody chose, billed to a vendor nobody picked (invariant #4). (In August
    // this case was `openrouter`, which then had no reader among its audio
    // models; it has had `/audio/speech` since 2026-09-23, so the unknown
    // provider is now one no adapter has ever had.)
    const err = (() => {
      try {
        getSpeechAdapter('nobody' as never);
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

  it('throws speech_provider_not_found for a transcription provider with no adapter', () => {
    // The mirror case: minimax speaks and does not listen.
    const err = (() => {
      try {
        getTranscriptionAdapter('minimax');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SpeechError);
    expect((err as SpeechError).code).toBe('speech_provider_not_found');
  });

  it('lists the two capabilities separately', () => {
    // Not every vendor does both, and the two lists are NOT the same set:
    // MiniMax synthesises without transcribing. One merged list would offer a
    // listening provider that cannot listen — the exact bug this separation
    // prevents.
    // `openai-compatible` (#1048) does both: a server the user runs, at its address.
    expect([...speechProviders()]).toEqual([
      'google',
      'minimax',
      'openrouter',
      'openai-compatible',
    ]);
    expect([...transcriptionProviders()]).toEqual(['google', 'openrouter', 'openai-compatible']);
  });

  it('only the adapters that really stream declare streamOutput', () => {
    // The flag is what a caller branches on to decide whether it can start
    // playing before the reply is finished. A vendor that returns a finished
    // file declaring it would make the caller wait in a code path built not to.
    expect(getSpeechAdapter('minimax').capabilities.streamOutput).toBe('audio/mpeg');
    expect(getSpeechAdapter('minimax').synthesizeStream).toBeTypeOf('function');
    // Google streams since #969 (streamGenerateContent, first event at 0.78 to
    // 1.13 s, measured 2026-11-03).
    expect(getSpeechAdapter('google').capabilities.streamOutput).toBe('audio/pcm');
    expect(getSpeechAdapter('google').synthesizeStream).toBeTypeOf('function');
    expect(getSpeechAdapter('openrouter').capabilities.streamOutput).toBe('audio/pcm');
    expect(getSpeechAdapter('openrouter').synthesizeStream).toBeTypeOf('function');
  });

  it('every listed provider actually resolves', () => {
    for (const p of speechProviders()) expect(getSpeechAdapter(p).provider).toBe(p);
    for (const p of transcriptionProviders()) expect(getTranscriptionAdapter(p).provider).toBe(p);
  });
});
