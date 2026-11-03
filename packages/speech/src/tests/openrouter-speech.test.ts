// openrouter-speech.test.ts — text to audio through OpenRouter /audio/speech
// (#487, moved from packages/llm in #940).
//
// The request is read as it leaves: the URL, the JSON body OpenRouter gets,
// and what comes back to the caller. The connection's fetch is a stub.

import { describe, it, expect } from 'vitest';
import {
  GEMINI_TTS_SAMPLE_RATE,
  OPENROUTER_SPEECH_MODELS,
  openrouterSpeechAdapter as adapter,
  speechBody,
} from '../providers/openrouter.ts';
import { bindSpeech } from '../bind.ts';
import { pcmToWav } from '../wav.ts';
import type { SpeechConnection } from '../speech-adapter.ts';

type Sent = { url: string; body: Record<string, unknown>; auth: string | null };

function stub(
  audio: Uint8Array,
  sent: Sent[],
  contentType = 'audio/pcm',
  status = 200,
): SpeechConnection {
  return {
    apiKey: 'sk-or-test',
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(new Blob([audio as Uint8Array<ArrayBuffer>]), {
        status,
        headers: { 'content-type': contentType },
      });
    },
  };
}

const le32 = (b: Uint8Array, o: number): number =>
  new DataView(b.buffer, b.byteOffset).getUint32(o, true);

describe('openrouterSpeechAdapter @cap:travailler-sur-des-fichiers/moteur', () => {
  // Run 16052ae6 (2026-09-25): OpenRouter answered "Gemini TTS only supports
  // response_format=\"pcm\". Got \"mp3\"." The request asks pcm, and the raw
  // samples come back wrapped in a WAV header.
  it('asks OpenRouter /audio/speech for pcm with the model, text and voice, and returns a WAV of those samples', async () => {
    const sent: Sent[] = [];
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);

    const out = await adapter.synthesize(
      { model: 'google/gemini-3.8-flash-lite-tts', text: 'Bonjour Quentin.', voiceId: 'Kore' },
      stub(pcm, sent),
    );

    expect(sent).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/audio/speech',
        auth: 'Bearer sk-or-test',
        body: {
          model: 'google/gemini-3.8-flash-lite-tts',
          input: 'Bonjour Quentin.',
          voice: 'Kore',
          response_format: 'pcm',
        },
      },
    ]);
    expect(out.mimeType).toBe('audio/wav');
    expect(out.sampleRate).toBe(GEMINI_TTS_SAMPLE_RATE);
    expect([...out.audio]).toEqual([...pcmToWav(pcm, { sampleRate: GEMINI_TTS_SAMPLE_RATE })]);
    expect([...out.audio.subarray(44)]).toEqual([...pcm]);
  });

  it('uses the first catalogue model when the request names none', async () => {
    const sent: Sent[] = [];
    await adapter.synthesize({ text: 'x', voiceId: 'Kore' }, stub(new Uint8Array([1, 0]), sent));
    expect(sent[0]!.body['model']).toBe('google/gemini-3.8-flash-tts');
    expect(OPENROUTER_SPEECH_MODELS[0].id).toBe('google/gemini-3.8-flash-tts');
  });

  it('reads the sample rate from the answer when it names one', async () => {
    const out = await adapter.synthesize(
      { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
      stub(new Uint8Array([9, 0]), [], 'audio/pcm;rate=16000'),
    );
    expect(le32(out.audio, 24)).toBe(16000);
  });

  // Review of PR #489: only a `rate` parameter is a sample rate.
  it('a bitrate parameter is not read as the sample rate', async () => {
    const out = await adapter.synthesize(
      { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
      stub(new Uint8Array([9, 0]), [], 'audio/pcm; bitrate=64000'),
    );
    expect(le32(out.audio, 24)).toBe(GEMINI_TTS_SAMPLE_RATE);
  });

  it('an odd number of bytes is a cut stream: refused, never wrapped', async () => {
    await expect(
      adapter.synthesize(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        stub(new Uint8Array([1, 0, 2]), []),
      ),
    ).rejects.toThrow(
      'google/gemini-3.8-flash-tts answered 3 bytes of 16-bit audio: an odd count, the stream was cut',
    );
  });

  it('a 200 that is not audio is said, never wrapped into a broken file', async () => {
    await expect(
      adapter.synthesize(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        stub(new TextEncoder().encode('{"error":1}'), [], 'application/json'),
      ),
    ).rejects.toThrow('answered application/json, not audio');
  });

  it('a 200 with no bytes is said, never written as a silent file', async () => {
    await expect(
      adapter.synthesize(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        stub(new Uint8Array(0), []),
      ),
    ).rejects.toMatchObject({
      code: 'speech_provider_error',
      message: 'google/gemini-3.8-flash-tts answered 200 with no audio',
    });
  });

  it('an HTTP error carries the status and the vendor’s words', async () => {
    const answer = new TextEncoder().encode(
      JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }),
    );
    await expect(
      adapter.synthesize(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        stub(answer, [], 'application/json', 402),
      ),
    ).rejects.toMatchObject({
      code: 'speech_provider_error',
      status: 402,
      message: 'openrouter google/gemini-3.8-flash-tts: HTTP 402 — Insufficient credits',
    });
  });

  it('sends a Gemini delivery style as provider options, never inside the spoken text', async () => {
    const sent: Sent[] = [];
    await adapter.synthesize(
      {
        model: 'google/gemini-3.8-flash-tts',
        text: 'Have a wonderful day!',
        voiceId: 'Kore',
        style: 'warm and friendly',
      },
      stub(new Uint8Array([1, 0]), sent),
    );

    expect(sent[0]!.body['input']).toBe('Have a wonderful day!');
    expect(sent[0]!.body['provider']).toEqual({
      options: { 'google-ai-studio': { speech_metadata: { style: 'warm and friendly' } } },
    });
  });

  it('adds no Google option for a model that is not Google, nor for an empty style', () => {
    expect(
      speechBody({ text: 'x', voiceId: 'nova', style: 'calm' }, 'openai/gpt-4o-mini-tts'),
    ).toEqual({
      model: 'openai/gpt-4o-mini-tts',
      input: 'x',
      voice: 'nova',
      response_format: 'pcm',
    });
    expect(
      speechBody({ text: 'x', voiceId: 'Kore', style: '  ' }, 'google/gemini-3.8-flash-tts')[
        'provider'
      ],
    ).toBeUndefined();
  });

  it('refuses empty text and an empty voice before any request leaves', async () => {
    const sent: Sent[] = [];
    const connection = stub(new Uint8Array([1, 0]), sent);
    await expect(adapter.synthesize({ text: '  ', voiceId: 'Kore' }, connection)).rejects.toThrow(
      'synthesize: text is empty',
    );
    await expect(adapter.synthesize({ text: 'x', voiceId: ' ' }, connection)).rejects.toThrow(
      'synthesize: voiceId is empty',
    );
    expect(sent).toEqual([]);
  });

  it('refuses to bind without a key', () => {
    expect(() => bindSpeech(adapter, { apiKey: '', fetch: globalThis.fetch })).toThrow(
      'openrouter: the connection has no API key',
    );
  });

  it('honours the base URL stored with the key', async () => {
    const sent: Sent[] = [];
    await adapter.synthesize(
      { text: 'x', voiceId: 'Kore' },
      { ...stub(new Uint8Array([1, 0]), sent), baseURL: 'https://proxy.example/api/v1' },
    );
    expect(sent[0]!.url).toBe('https://proxy.example/api/v1/audio/speech');
  });

  it('does not stream: a finished file is not a stream (#943 is the streaming step)', () => {
    expect(adapter.capabilities.streamOutput).toBeUndefined();
    expect(adapter.synthesizeStream).toBeUndefined();
  });
});
