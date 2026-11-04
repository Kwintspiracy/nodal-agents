// The transcription contract with OpenRouter, read off the wire (#940, #976).
//
// No network: the connection's `fetch` is a recorder that answers with the
// fixtures in ./fixtures. Those answers have the shape of OpenRouter's
// `/audio/transcriptions` answer (`{ text, usage }`) and of its error envelope
// (upstream words under `error.message`). What is asserted is the WHOLE
// request that leaves, and what the caller gets back from each answer.
//
// #976 removed the chat-completions path (a chat model asked, by an
// instruction, to write down what it heard): one mechanism, the endpoint.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openrouterTranscriptionAdapter as adapter } from '../providers/openrouter.ts';
import { SpeechError } from '../errors.ts';
import type { SpeechConnection } from '../speech-adapter.ts';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

type Sent = { url: string; headers: Headers; body: unknown };

function recording(answer: string, status = 200): { sent: Sent[]; connection: SpeechConnection } {
  const sent: Sent[] = [];
  const connection: SpeechConnection = {
    apiKey: 'sk-or-test',
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(answer, { status, headers: { 'content-type': 'application/json' } });
    },
  };
  return { sent, connection };
}

/** A short WAV-wrapped clip: what the client is meant to send (see ACCEPTED_INPUT). */
const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const MODEL = 'x-ai/grok-stt-1.0';

describe('openrouter transcription — the request on the wire @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: the old chat body (model + messages + instruction) sent
  // to `/chat/completions` → red.
  it('posts the named model and the audio in its container to /audio/transcriptions, and nothing else', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
    await adapter.transcribe(
      // A language the caller insists on is NOT sent: Nodal does not know it.
      { audio, mimeType: 'audio/wav', model: MODEL, language: 'en-US' },
      connection,
    );
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      [
        'https://openrouter.ai/api/v1/audio/transcriptions',
        {
          model: MODEL,
          input_audio: { data: Buffer.from(audio).toString('base64'), format: 'wav' },
        },
      ],
    ]);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-or-test');
    expect(sent[0]!.url).not.toContain('sk-or-test');
  });

  it('a request naming no model is refused before any call, never given one', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
    await expect(
      adapter.transcribe({ audio, mimeType: 'audio/wav' }, connection),
    ).rejects.toMatchObject({ code: 'speech_bad_request' });
    expect(sent).toEqual([]);
  });

  it('names each accepted container in OpenRouter’s format field, and only those', async () => {
    const expected: Record<string, string> = {
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/flac': 'flac',
    };
    expect([...adapter.capabilities.accepts]).toEqual(Object.keys(expected));
    for (const [mimeType, format] of Object.entries(expected)) {
      const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
      await adapter.transcribe(
        { audio, mimeType: mimeType as 'audio/wav', model: MODEL },
        connection,
      );
      expect((sent[0]!.body as { input_audio: { format: string } }).input_audio.format).toBe(
        format,
      );
    }
  });

  it('honours the base URL stored with the key', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
    await adapter.transcribe(
      { audio, mimeType: 'audio/wav', model: MODEL },
      { ...connection, baseURL: 'https://proxy.example/api/v1' },
    );
    expect(sent[0]!.url).toBe('https://proxy.example/api/v1/audio/transcriptions');
  });

  it('lists the transcription models OpenRouter serves', async () => {
    const { sent, connection } = recording(
      JSON.stringify({
        data: [
          { id: 'x-ai/grok-stt-1.0', name: 'SpaceXAI: Grok STT 1.0' },
          { id: 'deepgram/nova-3', name: 'Deepgram: Nova-3' },
        ],
      }),
    );
    expect(await adapter.listModels!(connection)).toEqual([
      { id: 'x-ai/grok-stt-1.0', label: 'SpaceXAI: Grok STT 1.0' },
      { id: 'deepgram/nova-3', label: 'Deepgram: Nova-3' },
    ]);
    expect(sent[0]!.url).toBe(
      'https://openrouter.ai/api/v1/models?output_modalities=transcription',
    );
  });
});

describe('openrouter transcription — what each answer becomes @cap:parler-a-un-agent/moteur', () => {
  it('returns the transcript of a 200, trimmed, with how long it took', async () => {
    const { connection } = recording(fixture('openrouter-transcription-ok.json'));
    const out = await adapter.transcribe(
      { audio, mimeType: 'audio/wav', model: MODEL },
      connection,
    );
    expect(out.text).toBe('Quelle heure est-il à Tokyo ?');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('an HTTP error carries the status and the upstream words', async () => {
    const { connection } = recording(fixture('openrouter-error-400.json'), 400);
    await expect(
      adapter.transcribe({ audio, mimeType: 'audio/wav', model: MODEL }, connection),
    ).rejects.toMatchObject({
      code: 'speech_provider_error',
      status: 400,
      message: `openrouter ${MODEL}: HTTP 400 — Provider returned error: Failed to load audio file`,
    });
  });

  it('a 200 with an empty transcript is nothing heard, never an empty turn', async () => {
    const { connection } = recording(fixture('openrouter-transcription-empty.json'));
    const err = await adapter
      .transcribe({ audio, mimeType: 'audio/wav', model: MODEL }, connection)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechError);
    expect(err).toMatchObject({ code: 'speech_nothing_heard' });
  });

  it('an unsupported container and empty audio are refused before any request leaves', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
    await expect(
      adapter.transcribe({ audio, mimeType: 'audio/webm', model: MODEL }, connection),
    ).rejects.toThrow('openrouter does not accept "audio/webm"');
    await expect(
      adapter.transcribe(
        { audio: new Uint8Array(0), mimeType: 'audio/wav', model: MODEL },
        connection,
      ),
    ).rejects.toThrow('transcribe: audio is empty');
    expect(sent).toEqual([]);
  });
});
