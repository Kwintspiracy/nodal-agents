// speech-models.test.ts — text to audio through OpenRouter (#487).
//
// The request is read as it leaves: the URL, the JSON body OpenRouter gets,
// and what comes back to the caller. The fetch is a stub; the AI SDK's real
// speech model builds the request.

import { describe, it, expect } from 'vitest';
import { createOpenRouterSpeech, withGeminiStyle } from '../providers/speech-models';

type Sent = { url: string; body: Record<string, unknown>; auth: string | null };

function stubFetch(audio: Uint8Array, sent: Sent[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: headers.get('authorization'),
    });
    return new Response(new Blob([audio as Uint8Array<ArrayBuffer>]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  }) as typeof fetch;
}

describe('createOpenRouterSpeech @cap:travailler-sur-des-fichiers/moteur', () => {
  it('asks OpenRouter /audio/speech for mp3 with the model, text and voice, and returns the bytes', async () => {
    const sent: Sent[] = [];
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const speak = createOpenRouterSpeech('sk-or-test', { fetch: stubFetch(mp3, sent) });

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
      response_format: 'mp3',
    });
    expect(sent[0]!.body['provider']).toBeUndefined();
    expect([...audio.bytes]).toEqual([...mp3]);
    // The AI SDK names the type from the requested format.
    expect(audio.mediaType).toBe('audio/mp3');
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
