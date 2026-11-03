// google-stream.test.ts — Gemini TTS en direct, EN FLUX (#969).
//
// `streamGenerateContent?alt=sse` répond des Server-Sent Events, chacun avec un
// morceau de PCM en base64. Ce que ces tests prouvent, sur un flux synthétique
// de la forme mesurée le 03/11 (`mimeType "audio/l16; rate=24000; channels=1"`) :
//   - la requête : l'URL du modèle choisi, la clé en en-tête, la voix ;
//   - les morceaux sortent DANS L'ORDRE, octets intacts (little-endian, jamais
//     retournés), et le premier sort AVANT que le flux finisse ;
//   - une clé sans crédit (402) se dit comme telle, et un flux coupé aussi ;
//   - les modèles viennent de l'API des modèles de Google.

import { describe, it, expect } from 'vitest';
import { googleSpeechAdapter as adapter, GEMINI_VOICES } from '../providers/google.ts';
import type { SpeechConnection, SpeechStreamChunk } from '../speech-adapter.ts';

const L16 = 'audio/l16; rate=24000; channels=1';

/** One SSE event of `streamGenerateContent`, carrying these PCM bytes. */
function audioEvent(bytes: number[], mimeType = L16): string {
  const data = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } }],
        },
      },
    ],
  };
  return `data: ${JSON.stringify(data)}\r\n\r\n`;
}

/** The closing event: usage only, no audio. */
const CLOSING = `data: ${JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 4 },
})}\r\n\r\n`;

type Sent = { url: string; key: string | null; body: unknown };

/** A connection whose SSE body the test writes, event by event, while the adapter reads. */
function heldSse(status = 200, errorBody?: string) {
  const sent: Sent[] = [];
  let push!: (text: string) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      push = (text) => controller.enqueue(enc.encode(text));
      end = () => controller.close();
    },
  });
  const connection: SpeechConnection = {
    apiKey: 'AIza-test',
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        key: new Headers(init?.headers).get('x-goog-api-key'),
        body: JSON.parse(String(init?.body)),
      });
      if (errorBody !== undefined) return new Response(errorBody, { status });
      return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
    },
  };
  return { sent, connection, push, end };
}

async function drain(it: AsyncIterable<SpeechStreamChunk>): Promise<SpeechStreamChunk[]> {
  const out: SpeechStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('googleSpeechAdapter.synthesizeStream (#969) @cap:parler-a-un-agent/moteur', () => {
  it('asks the chosen model for an SSE stream of AUDIO, with the voice and the key', async () => {
    const held = heldSse();
    const reading = drain(
      adapter.synthesizeStream!(
        { model: 'gemini-3.8-flash-tts', text: 'Hello there.', voiceId: 'Kore' },
        held.connection,
      ),
    );
    held.push(audioEvent([1, 0]));
    held.end();
    await reading;
    expect(held.sent).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent?alt=sse',
        key: 'AIza-test',
        body: {
          contents: [{ parts: [{ text: 'Hello there.' }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          },
        },
      },
    ]);
  });

  // Mutation verified: the events read only once the body ends (the generator
  // collecting every event before yielding) → red, the first chunk never comes
  // while the stream is held open.
  it('emits the first chunk before the stream ends, then the rest in order, bytes untouched', async () => {
    const held = heldSse();
    const stream = adapter.synthesizeStream!(
      { model: 'gemini-3.8-flash-tts', text: 'Hello.', voiceId: 'Kore' },
      held.connection,
    )[Symbol.asyncIterator]();

    // Little-endian samples 0x0201, 0x0403: passed through as they came, never swapped.
    held.push(audioEvent([0x01, 0x02, 0x03, 0x04]));
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect([...first.value!.audio]).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(first.value!.sampleRate).toBe(24_000);

    held.push(audioEvent([0x05, 0x06]));
    // An event split across two network reads is still one event.
    const split = audioEvent([0x07, 0x08]);
    held.push(split.slice(0, 20));
    held.push(split.slice(20));
    held.push(CLOSING);
    held.end();
    const rest: number[][] = [];
    for (let r = await stream.next(); !r.done; r = await stream.next())
      rest.push([...r.value.audio]);
    expect(rest).toEqual([
      [0x05, 0x06],
      [0x07, 0x08],
    ]);
  });

  // Mutation verified: the carry removed (each event yielded as it decodes) →
  // red, a chunk of 3 bytes leaves.
  it('carries a byte split between two events, so every chunk holds whole samples', async () => {
    const held = heldSse();
    const reading = drain(
      adapter.synthesizeStream!(
        { model: 'gemini-3.8-flash-lite-tts', text: 'x', voiceId: 'Puck' },
        held.connection,
      ),
    );
    held.push(audioEvent([1, 2, 3]));
    held.push(audioEvent([4, 5, 6, 7, 8]));
    held.end();
    const chunks = await reading;
    expect(chunks.map((c) => [...c.audio])).toEqual([
      [1, 2],
      [3, 4, 5, 6, 7, 8],
    ]);
  });

  it('a key without credit (402) is said as such, with Google’s words', async () => {
    const held = heldSse(
      402,
      JSON.stringify([{ error: { code: 402, message: 'Your prepayment credits are depleted.' } }]),
    );
    await expect(
      drain(
        adapter.synthesizeStream!(
          { model: 'gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
          held.connection,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'speech_no_credit',
      status: 402,
      message: 'google gemini-3.8-flash-tts: HTTP 402 — Your prepayment credits are depleted.',
    });
  });

  it('a stream cut mid-event, an odd byte count and a stream with no audio are said', async () => {
    const cut = heldSse();
    const cutReading = drain(
      adapter.synthesizeStream!(
        { model: 'gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        cut.connection,
      ),
    );
    cut.push(audioEvent([1, 0]));
    cut.push('data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType"');
    cut.end();
    await expect(cutReading).rejects.toThrow('the stream was cut');

    const odd = heldSse();
    const oddReading = drain(
      adapter.synthesizeStream!(
        { model: 'gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        odd.connection,
      ),
    );
    odd.push(audioEvent([1, 0, 2]));
    odd.end();
    await expect(oddReading).rejects.toThrow('3 bytes of 16-bit audio, an odd count');

    const silent = heldSse();
    const silentReading = drain(
      adapter.synthesizeStream!(
        { model: 'gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' },
        silent.connection,
      ),
    );
    silent.push(CLOSING);
    silent.end();
    await expect(silentReading).rejects.toThrow('the stream carried no audio');
  });

  it('refuses a voice Gemini does not offer before any request leaves', () => {
    const held = heldSse();
    expect(() =>
      adapter.synthesizeStream!(
        { model: 'gemini-3.8-flash-tts', text: 'x', voiceId: 'leo' },
        held.connection,
      ),
    ).toThrow('unknown google voice "leo"');
    expect(held.sent).toEqual([]);
  });
});

describe('googleSpeechAdapter.listModels (#969) @cap:parler-a-un-agent/moteur', () => {
  it('lists the TTS models of Google’s models API, across pages, with the prebuilt voices', async () => {
    const urls: string[] = [];
    const pages = [
      {
        models: [
          { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
          { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS' },
        ],
        nextPageToken: 'p2',
      },
      {
        models: [
          { name: 'models/gemini-3.8-flash-lite-tts', displayName: 'Gemini 3.8 Flash Lite TTS' },
        ],
      },
    ];
    const connection: SpeechConnection = {
      apiKey: 'AIza-test',
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(pages[urls.length - 1]));
      },
    };
    const models = await adapter.listModels!(connection);
    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=p2',
    ]);
    expect(models.map((m) => [m.id, m.label])).toEqual([
      ['gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS'],
      ['gemini-3.8-flash-lite-tts', 'Gemini 3.8 Flash Lite TTS'],
    ]);
    expect(models[0]!.voices).toBe(GEMINI_VOICES);
  });

  it('a refused list is said with its code, never read as empty', async () => {
    const connection: SpeechConnection = {
      apiKey: 'AIza-test',
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: 'Your prepayment credits are depleted.' } }),
          {
            status: 402,
          },
        ),
    };
    await expect(adapter.listModels!(connection)).rejects.toMatchObject({
      code: 'speech_no_credit',
      message: 'google models: HTTP 402 — Your prepayment credits are depleted.',
    });
  });
});
