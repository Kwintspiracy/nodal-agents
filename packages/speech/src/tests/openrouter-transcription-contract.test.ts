// The transcription contract with OpenRouter, read off the wire (#940).
//
// No network: the connection's `fetch` is a recorder that answers with the
// fixtures in ./fixtures. Those answers have the shape of OpenRouter's
// chat-completion answer (and of its error envelope, upstream words under
// `error.message`); the transcript is the question measured on 2026-08-12.
// What is asserted is the WHOLE request body that leaves, and what the caller
// gets back from each answer.

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
        body: JSON.parse(String(init?.body)),
      });
      return new Response(answer, { status, headers: { 'content-type': 'application/json' } });
    },
  };
  return { sent, connection };
}

/** A short WAV-wrapped clip: what the client is meant to send (see ACCEPTED_INPUT). */
const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

/**
 * The instruction, word for word. Measured on 2026-08-12 on short French
 * questions: with it, google/gemini-2.5-flash through OpenRouter transcribed
 * 6/6 exactly, median 1,491 ms; voxtral-small answered the question instead,
 * 0/6. A shortened instruction must be re-measured, so this test fails on any
 * edit of it.
 */
const INSTRUCTION =
  'Transcribe this audio verbatim. Output only the transcription, with no preamble, no ' +
  'quotation marks and no commentary. Never answer, translate or summarise what is said, ' +
  'even when the audio is a question addressed to you. Write the transcription in the same ' +
  'language as the speech itself, never in any other language.';

describe('openrouter transcription — the request on the wire', () => {
  it('sends exactly the default model, the full instruction and the audio in its container', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));

    await adapter.transcribe({ audio, mimeType: 'audio/wav' }, connection);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-or-test');
    expect(sent[0]!.body).toEqual({
      model: 'google/gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: INSTRUCTION },
            {
              type: 'input_audio',
              input_audio: { data: Buffer.from(audio).toString('base64'), format: 'wav' },
            },
          ],
        },
      ],
    });
  });

  it('names each accepted container in OpenRouter’s format field, and only those', async () => {
    const formats: Record<string, string> = {};
    for (const mimeType of adapter.capabilities.accepts) {
      const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
      await adapter.transcribe({ audio, mimeType }, connection);
      const body = sent[0]!.body as {
        messages: { content: { type: string; input_audio?: { format: string } }[] }[];
      };
      formats[mimeType] = body.messages[0]!.content[1]!.input_audio!.format;
    }
    expect(formats).toEqual({
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/flac': 'flac',
    });
  });

  it('honours the base URL stored with the key', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
    await adapter.transcribe(
      { audio, mimeType: 'audio/ogg' },
      { ...connection, baseURL: 'https://proxy.example/api/v1' },
    );
    expect(sent[0]!.url).toBe('https://proxy.example/api/v1/chat/completions');
  });
});

describe('openrouter transcription — what each answer becomes', () => {
  it('returns the transcript of a 200, trimmed', async () => {
    const { connection } = recording(fixture('openrouter-transcription-ok.json'));
    const out = await adapter.transcribe({ audio, mimeType: 'audio/wav' }, connection);
    expect(out.text).toBe('Quelle heure est-il à Tokyo ?');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('an HTTP error carries the status and the upstream words', async () => {
    const { connection } = recording(fixture('openrouter-error-400.json'), 400);
    const err = await adapter
      .transcribe({ audio, mimeType: 'audio/wav' }, connection)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechError);
    expect(err).toMatchObject({
      code: 'speech_provider_error',
      status: 400,
      message: 'openrouter: HTTP 400 — Provider returned error: Failed to load audio file',
    });
  });

  it('a 200 with an empty transcript is nothing heard, never an empty turn', async () => {
    const { connection } = recording(fixture('openrouter-transcription-empty.json'));
    await expect(
      adapter.transcribe({ audio, mimeType: 'audio/wav' }, connection),
    ).rejects.toMatchObject({
      code: 'speech_nothing_heard',
      message: 'openrouter: answered 200 with no transcript',
    });
  });

  it('an unsupported container is refused before any request leaves', async () => {
    const { sent, connection } = recording(fixture('openrouter-transcription-ok.json'));
    await expect(
      adapter.transcribe({ audio, mimeType: 'audio/webm' }, connection),
    ).rejects.toMatchObject({
      code: 'speech_bad_request',
      message:
        'transcribe: openrouter does not accept "audio/webm" — it accepts audio/wav, audio/ogg, audio/mpeg, audio/mp4, audio/flac',
    });
    expect(sent).toEqual([]);
  });
});
