// openrouter-speech.test.ts — text to audio through OpenRouter /audio/speech
// (#487, moved from packages/llm in #940).
//
// The request is read as it leaves: the URL, the JSON body OpenRouter gets,
// and what comes back to the caller. The connection's fetch is a stub.

import { describe, it, expect } from 'vitest';
import {
  GEMINI_TTS_SAMPLE_RATE,
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

  // #969: the adapter picks no model; the workspace's voice setting names it.
  // Mutation verified: the old default (`req.model ?? the first Gemini model`)
  // restored → red, a request leaves.
  it('a request naming no model is refused before any call, never given one', async () => {
    const sent: Sent[] = [];
    await expect(
      adapter.synthesize({ text: 'x', voiceId: 'Kore' }, stub(new Uint8Array([1, 0]), sent)),
    ).rejects.toMatchObject({ code: 'speech_bad_request' });
    expect(() =>
      adapter.synthesizeStream!({ text: 'x', voiceId: 'Kore' }, stub(new Uint8Array([1, 0]), sent)),
    ).toThrow('openrouter needs the model');
    expect(sent).toEqual([]);
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

  // #969: a key without credit is its own code. Mutation verified:
  // `vendorRefusalCode` answering `speech_provider_error` for 402 → red.
  it('an HTTP error carries the status and the vendor’s words; 402 is said as no credit', async () => {
    const answer = new TextEncoder().encode(
      JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }),
    );
    await expect(
      adapter.synthesize(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        stub(answer, [], 'application/json', 402),
      ),
    ).rejects.toMatchObject({
      code: 'speech_no_credit',
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
      { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
      { ...stub(new Uint8Array([1, 0]), sent), baseURL: 'https://proxy.example/api/v1' },
    );
    expect(sent[0]!.url).toBe('https://proxy.example/api/v1/audio/speech');
  });

  // #969: MiniMax answers mp3 only (measured 2026-11-03). Mutation verified:
  // the pcm check removed from `openSpeech` → red (the mp3 bytes come back
  // wrapped in a WAV, and streamed as samples).
  it('an answer in another container than pcm is said, never wrapped nor played as samples', async () => {
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    await expect(
      adapter.synthesize(
        { model: 'minimax/speech-2.8-turbo', text: 'x', voiceId: 'English_CalmWoman' },
        stub(mp3, [], 'audio/mpeg'),
      ),
    ).rejects.toThrow(
      'minimax/speech-2.8-turbo answered audio/mpeg, where Nodal reads pcm from this route',
    );
    await expect(
      (async () => {
        for await (const _ of adapter.synthesizeStream!(
          { model: 'minimax/speech-2.8-turbo', text: 'x', voiceId: 'English_CalmWoman' },
          stub(mp3, [], 'audio/mpeg'),
        )) {
          // drained
        }
      })(),
    ).rejects.toThrow('answered audio/mpeg');
  });

  // #969: the choices come from OpenRouter. A trimmed copy of the real answer
  // of `GET /models?output_modalities=speech` (2026-11-03).
  it('lists the speech models OpenRouter serves, each with the voices it lists', async () => {
    const answer = {
      data: [
        {
          id: 'x-ai/grok-voice-tts-1.0',
          name: 'SpaceXAI: Grok Voice TTS 1.0',
          supported_voices: ['eve', 'ara', 'rex', 'sal', 'leo'],
        },
        { id: 'fish-audio/s1', name: 'Fish Audio: S1', supported_voices: null },
        {
          id: 'google/gemini-3.8-flash-tts',
          name: 'Google: Gemini 3.8 Flash TTS',
          supported_voices: ['Zephyr', 'Kore'],
        },
      ],
    };
    const seen: Array<{ url: string; auth: string | null }> = [];
    const connection: SpeechConnection = {
      apiKey: 'sk-or-test',
      fetch: async (input, init) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(answer), {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const models = await adapter.listModels!(connection);
    expect(seen).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/models?output_modalities=speech',
        auth: 'Bearer sk-or-test',
      },
    ]);
    expect(models.map((m) => [m.id, m.label, m.voices.map((v) => v.id)])).toEqual([
      [
        'x-ai/grok-voice-tts-1.0',
        'SpaceXAI: Grok Voice TTS 1.0',
        ['eve', 'ara', 'rex', 'sal', 'leo'],
      ],
      ['fish-audio/s1', 'Fish Audio: S1', []],
      ['google/gemini-3.8-flash-tts', 'Google: Gemini 3.8 Flash TTS', ['Zephyr', 'Kore']],
    ]);
  });

  it('a models list refused or unreadable is said, never read as empty', async () => {
    const refused: SpeechConnection = {
      apiKey: 'sk-or-test',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), {
          status: 402,
        }),
    };
    await expect(adapter.listModels!(refused)).rejects.toMatchObject({
      code: 'speech_no_credit',
      message: 'openrouter models: HTTP 402 — Insufficient credits',
    });
    const shapeless: SpeechConnection = {
      apiKey: 'sk-or-test',
      fetch: async () => new Response('{"models":[]}'),
    };
    await expect(adapter.listModels!(shapeless)).rejects.toThrow(
      'openrouter models: the answer has no data',
    );
  });

  it('declares its stream: raw PCM (#943)', () => {
    expect(adapter.capabilities.streamOutput).toBe('audio/pcm');
    expect(adapter.synthesizeStream).toBeTypeOf('function');
  });
});

/** A connection whose answer body the test writes, chunk by chunk, while the caller reads. */
function heldStream(contentType = 'audio/pcm') {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const sent: Sent[] = [];
  const connection: SpeechConnection = {
    apiKey: 'sk-or-test',
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    },
  };
  return {
    connection,
    sent,
    write: (b: number[]) => controller.enqueue(Uint8Array.from(b)),
    end: () => controller.close(),
  };
}

describe('openrouterSpeechAdapter.synthesizeStream (#943) @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: `synthesizeStream` reading `res.arrayBuffer()` and
  // yielding it whole → "yields the first bytes before the answer ends" is red
  // (the first read waits for `end()`); the carry removed → "a sample split
  // across two network chunks" is red.
  it('yields the first bytes before the answer ends, with the same request as the one-shot path', async () => {
    const held = heldStream();
    const it = adapter.synthesizeStream!(
      { model: 'google/gemini-3.8-flash-tts', text: 'Bonjour.', voiceId: 'Kore' },
      held.connection,
    )[Symbol.asyncIterator]();
    const first = it.next();
    held.write([1, 0, 2, 0]);
    expect(await first).toEqual({
      done: false,
      value: { audio: Uint8Array.from([1, 0, 2, 0]), sampleRate: GEMINI_TTS_SAMPLE_RATE },
    });
    // The answer is still open: the second read waits for it.
    const second = it.next();
    held.write([3, 0]);
    held.end();
    expect(await second).toEqual({
      done: false,
      value: { audio: Uint8Array.from([3, 0]), sampleRate: GEMINI_TTS_SAMPLE_RATE },
    });
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(held.sent[0]!.body).toEqual(
      speechBody({ text: 'Bonjour.', voiceId: 'Kore' }, 'google/gemini-3.8-flash-tts'),
    );
  });

  it('a sample split across two network chunks is carried, never yielded in halves', async () => {
    const held = heldStream();
    const out: number[][] = [];
    const reading = (async () => {
      for await (const c of adapter.synthesizeStream!(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        held.connection,
      )) {
        out.push([...c.audio]);
      }
    })();
    held.write([1, 0, 2]);
    held.write([0, 3, 0]);
    held.end();
    await reading;
    expect(out).toEqual([
      [1, 0],
      [2, 0, 3, 0],
    ]);
  });

  // Mutation verified: the rate fixed at 24 kHz instead of read from the
  // answer → "the rate is the answer’s" is red.
  it('the rate is the answer’s, read from its content type, never assumed', async () => {
    for (const [contentType, rate] of [
      ['audio/pcm;rate=44100;channels=1', 44_100],
      ['audio/pcm;rate=24000;channels=1', 24_000],
      ['audio/pcm', GEMINI_TTS_SAMPLE_RATE],
    ] as const) {
      const held = heldStream(contentType);
      const rates: Array<number | undefined> = [];
      const reading = (async () => {
        for await (const c of adapter.synthesizeStream!(
          { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
          held.connection,
        )) {
          rates.push(c.sampleRate);
        }
      })();
      held.write([1, 0]);
      held.end();
      await reading;
      expect({ contentType, rates }).toEqual({ contentType, rates: [rate] });
    }
  });

  it('a stream cut mid-sample, an empty answer and a layout that is not mono are said, never played', async () => {
    const cut = heldStream();
    const reading = (async () => {
      for await (const _ of adapter.synthesizeStream!(
        { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        cut.connection,
      )) {
        // drained
      }
    })();
    cut.write([1, 0, 2]);
    cut.end();
    await expect(reading).rejects.toThrow(
      '3 bytes of 16-bit audio: an odd count, the stream was cut',
    );

    const empty = heldStream();
    empty.end();
    await expect(
      (async () => {
        for await (const _ of adapter.synthesizeStream!(
          { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
          empty.connection,
        )) {
          // drained
        }
      })(),
    ).rejects.toThrow('answered 200 with no audio');

    const other = heldStream('audio/pcm;rate=24000;channels=2');
    await expect(
      (async () => {
        for await (const _ of adapter.synthesizeStream!(
          { model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
          other.connection,
        )) {
          // drained
        }
      })(),
    ).rejects.toThrow('2 channels, where the stream is mono');
  });

  it('refuses empty text before any request leaves', () => {
    const held = heldStream();
    expect(() =>
      adapter.synthesizeStream!({ text: ' ', voiceId: 'Kore' }, held.connection),
    ).toThrow('synthesize: text is empty');
    expect(held.sent).toEqual([]);
  });
});
