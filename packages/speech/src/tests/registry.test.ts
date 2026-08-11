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
    // openrouter transcribes and does NOT synthesise: its four audio-output
    // models are two music generators and two conversational models that rewrite
    // what they are asked to read. Returning "the other one" here would make an
    // agent speak in a voice nobody chose, billed to a vendor nobody picked
    // (invariant #4).
    const err = (() => {
      try {
        getSpeechAdapter('openrouter');
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
    // MiniMax synthesises without transcribing, OpenRouter transcribes without
    // synthesising. One merged list would offer a listening provider that cannot
    // listen — the exact bug this separation prevents.
    expect([...speechProviders()]).toEqual(['google', 'minimax']);
    expect([...transcriptionProviders()]).toEqual(['google', 'openrouter']);
  });

  it('only the adapters that really stream declare streamOutput', () => {
    // The flag is what a caller branches on to decide whether it can start
    // playing before the reply is finished. A vendor that returns a finished
    // file declaring it would make the caller wait in a code path built not to.
    expect(getSpeechAdapter('minimax').capabilities.streamOutput).toBe('audio/mpeg');
    expect(getSpeechAdapter('minimax').synthesizeStream).toBeTypeOf('function');
    expect(getSpeechAdapter('google').capabilities.streamOutput).toBeUndefined();
    expect(getSpeechAdapter('google').synthesizeStream).toBeUndefined();
  });

  it('every listed provider actually resolves', () => {
    for (const p of speechProviders()) expect(getSpeechAdapter(p).provider).toBe(p);
    for (const p of transcriptionProviders()) expect(getTranscriptionAdapter(p).provider).toBe(p);
  });
});
