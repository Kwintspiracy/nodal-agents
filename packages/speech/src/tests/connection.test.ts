// Every adapter speaks through the connection it is handed (#940, #608).
//
// The global `fetch` is replaced by one that throws: an adapter that reached
// for it instead of `connection.fetch` would leave the provider transport of
// packages/llm, and fail here. And `bindSpeech` must carry the adapter's whole
// surface, the streaming half included, so a streaming caller (#943) gets it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { bindSpeech, bindTranscription } from '../bind.ts';
import { getSpeechAdapter, getTranscriptionAdapter } from '../registry.ts';
import type { SpeechConnection } from '../speech-adapter.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The answer each vendor gives to a successful call, enough to complete it. */
function answerFor(url: string): Response {
  if (url.includes('/audio/speech')) {
    return new Response(new Uint8Array([1, 0, 2, 0]), {
      headers: { 'content-type': 'audio/pcm' },
    });
  }
  if (url.includes('/t2a_v2')) {
    const line = `data: ${JSON.stringify({ data: { audio: 'aabb', status: 1 }, base_resp: { status_code: 0 } })}\n`;
    return new Response(line);
  }
  if (url.includes('preview-tts')) {
    return Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/L16;codec=pcm;rate=24000',
                  data: Buffer.from([1, 0]).toString('base64'),
                },
              },
            ],
          },
        },
      ],
    });
  }
  if (url.includes('/chat/completions')) {
    return Response.json({ choices: [{ message: { content: 'bonjour' } }] });
  }
  return Response.json({ candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] });
}

function recorder(): { urls: string[]; connection: SpeechConnection } {
  const urls: string[] = [];
  return {
    urls,
    connection: {
      apiKey: 'k',
      fetch: async (input) => {
        urls.push(String(input));
        return answerFor(String(input));
      },
    },
  };
}

const VOICE = { google: 'Kore', minimax: 'French_CasualMan', openrouter: 'Kore' } as const;

describe('adapters use the connection’s fetch, never the global one', () => {
  for (const provider of ['google', 'minimax', 'openrouter'] as const) {
    it(`${provider} synthesis`, async () => {
      vi.stubGlobal('fetch', () => {
        throw new Error('the global fetch was used');
      });
      const { urls, connection } = recorder();
      const out = await getSpeechAdapter(provider).synthesize(
        { text: 'Bonjour.', voiceId: VOICE[provider] },
        connection,
      );
      expect(out.audio.length).toBeGreaterThan(0);
      expect(urls).toHaveLength(1);
    });
  }

  for (const provider of ['google', 'openrouter'] as const) {
    it(`${provider} transcription`, async () => {
      vi.stubGlobal('fetch', () => {
        throw new Error('the global fetch was used');
      });
      const { urls, connection } = recorder();
      const out = await getTranscriptionAdapter(provider).transcribe(
        { audio: new Uint8Array([1, 2]), mimeType: 'audio/wav' },
        connection,
      );
      expect(out.text).toBe('bonjour');
      expect(urls).toHaveLength(1);
    });
  }
});

describe('bindSpeech / bindTranscription', () => {
  it('a bound adapter speaks with the connection it was bound to', async () => {
    const { urls, connection } = recorder();
    const speech = bindSpeech(getSpeechAdapter('openrouter'), {
      ...connection,
      baseURL: 'https://proxy.example/api/v1',
    });
    const out = await speech.synthesize({ text: 'x', voiceId: 'Kore' });
    expect(urls).toEqual(['https://proxy.example/api/v1/audio/speech']);
    expect(String.fromCharCode(...out.audio.subarray(0, 4))).toBe('RIFF');
    expect(speech.capabilities).toBe(getSpeechAdapter('openrouter').capabilities);
  });

  it('keeps the streaming half of an adapter that has one, and only then', async () => {
    const { connection } = recorder();
    const minimax = bindSpeech(getSpeechAdapter('minimax'), connection);
    const chunks: number[] = [];
    for await (const c of minimax.synthesizeStream!({ text: 'x', voiceId: 'French_CasualMan' })) {
      chunks.push(...c.audio);
    }
    expect(chunks).toEqual([0xaa, 0xbb]);
    expect(bindSpeech(getSpeechAdapter('google'), connection).synthesizeStream).toBeUndefined();
  });

  it('a bound transcription transcribes with its connection', async () => {
    const { urls, connection } = recorder();
    const listen = bindTranscription(getTranscriptionAdapter('openrouter'), connection);
    const out = await listen.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/ogg' });
    expect(out.text).toBe('bonjour');
    expect(urls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('refuses an empty key when binding', () => {
    expect(() =>
      bindTranscription(getTranscriptionAdapter('google'), {
        apiKey: ' ',
        fetch: globalThis.fetch,
      }),
    ).toThrow('google: the connection has no API key');
  });
});
