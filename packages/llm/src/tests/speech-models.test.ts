// speech-models.test.ts — text to audio through OpenRouter (#487).
//
// The request is read as it leaves: the URL, the JSON body OpenRouter gets,
// and what comes back to the caller. The fetch is a stub; the AI SDK's real
// speech model builds the request.

import { describe, it, expect } from 'vitest';
import {
  createOpenRouterSpeech,
  withGeminiStyle,
  pcmToWav,
  GEMINI_TTS_SAMPLE_RATE,
} from '../providers/speech-models';

type Sent = { url: string; body: Record<string, unknown>; auth: string | null };

function stubFetch(audio: Uint8Array, sent: Sent[], contentType = 'audio/pcm'): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: headers.get('authorization'),
    });
    return new Response(new Blob([audio as Uint8Array<ArrayBuffer>]), {
      status: 200,
      headers: { 'content-type': contentType },
    });
  }) as typeof fetch;
}

describe('createOpenRouterSpeech @cap:travailler-sur-des-fichiers/moteur', () => {
  // Run 16052ae6 (2026-09-25): OpenRouter answered "Gemini TTS only supports
  // response_format=\"pcm\". Got \"mp3\"." The request asks pcm, and the raw
  // samples come back wrapped in a WAV header.
  it('asks OpenRouter /audio/speech for pcm with the model, text and voice, and returns a WAV of those samples', async () => {
    const sent: Sent[] = [];
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);
    const speak = createOpenRouterSpeech('sk-or-test', { fetch: stubFetch(pcm, sent) });

    const audio = await speak({
      model: 'google/gemini-3.8-flash-lite-tts',
      text: 'Bonjour Quentin.',
      voice: 'Kore',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(sent[0]!.auth).toBe('Bearer sk-or-test');
    expect(sent[0]!.body).toMatchObject({
      model: 'google/gemini-3.8-flash-lite-tts',
      input: 'Bonjour Quentin.',
      voice: 'Kore',
      response_format: 'pcm',
    });
    expect(sent[0]!.body['provider']).toBeUndefined();
    expect(audio.mediaType).toBe('audio/wav');
    expect([...audio.bytes]).toEqual([...pcmToWav(pcm, GEMINI_TTS_SAMPLE_RATE)]);
    expect([...audio.bytes.subarray(44)]).toEqual([...pcm]);
  });

  it('reads the sample rate from the answer when it names one', async () => {
    const speak = createOpenRouterSpeech('sk-or-test', {
      fetch: stubFetch(new Uint8Array([9, 0]), [], 'audio/pcm;rate=16000'),
    });
    const audio = await speak({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore' });
    expect(new DataView(audio.bytes.buffer).getUint32(24, true)).toBe(16000);
  });

  it('a 200 that is not audio is said, never wrapped into a broken file', async () => {
    const speak = createOpenRouterSpeech('sk-or-test', {
      fetch: stubFetch(new TextEncoder().encode('{"error":1}'), [], 'application/json'),
    });
    await expect(
      speak({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore' }),
    ).rejects.toThrow('answered application/json, not audio');
  });

  it('pcmToWav writes a 16-bit mono RIFF header before the samples', () => {
    const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]), 24_000);
    const view = new DataView(wav.buffer);
    const tag = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(36 + 4);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000); // byte rate
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it('sends a Gemini delivery style as provider options, never inside the spoken text', async () => {
    const sent: Sent[] = [];
    const speak = createOpenRouterSpeech('sk-or-test', {
      fetch: stubFetch(new Uint8Array([1]), sent),
    });

    await speak({
      model: 'google/gemini-3.8-flash-tts',
      text: 'Have a wonderful day!',
      voice: 'Kore',
      style: 'warm and friendly',
    });

    expect(sent[0]!.body['input']).toBe('Have a wonderful day!');
    expect(sent[0]!.body['provider']).toEqual({
      options: { 'google-ai-studio': { speech_metadata: { style: 'warm and friendly' } } },
    });
  });

  it('adds no Google option for a model that is not Google, nor for an empty style', async () => {
    const sent: Sent[] = [];
    const speak = createOpenRouterSpeech('sk-or-test', {
      fetch: stubFetch(new Uint8Array([1]), sent),
    });

    await speak({ model: 'openai/gpt-4o-mini-tts', text: 'x', voice: 'nova', style: 'calm' });
    await speak({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore', style: '  ' });

    expect(sent.map((s) => s.body['provider'])).toEqual([undefined, undefined]);
  });

  it('refuses to build without a key', () => {
    expect(() => createOpenRouterSpeech('')).toThrow('requires an apiKey');
  });

  it('withGeminiStyle keeps every field and adds the provider options', () => {
    const body = JSON.stringify({ model: 'm', input: 'x', voice: 'Kore', response_format: 'mp3' });
    expect(JSON.parse(withGeminiStyle(body, 'whispering'))).toEqual({
      model: 'm',
      input: 'x',
      voice: 'Kore',
      response_format: 'mp3',
      provider: { options: { 'google-ai-studio': { speech_metadata: { style: 'whispering' } } } },
    });
  });

  it('withGeminiStyle merges into a provider field already there, never replaces it (review of PR #488)', () => {
    const body = JSON.stringify({ model: 'm', provider: { order: ['google-ai-studio'] } });
    expect(JSON.parse(withGeminiStyle(body, 'calm'))).toEqual({
      model: 'm',
      provider: {
        order: ['google-ai-studio'],
        options: { 'google-ai-studio': { speech_metadata: { style: 'calm' } } },
      },
    });
  });
});
