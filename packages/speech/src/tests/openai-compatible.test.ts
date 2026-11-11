// openai-compatible.test.ts — a server the USER runs, reached at its address by
// the standard OpenAI audio surface (#1048), against a REAL HTTP server.
//
// Every assertion is on what crossed the wire (the multipart fields, the
// model, the audio bytes, the headers) or on what the adapter returned: the
// server is real, started on a free port by the test.

import { afterEach, describe, expect, it } from 'vitest';
import {
  closedServerAddress,
  startFakeSpeechServer,
  type FakeSpeechServer,
} from '@nodal-agents/test-kit';
import { bindSpeech, bindTranscription } from '../bind.ts';
import { SpeechError } from '../errors.ts';
import {
  openaiCompatibleSpeechAdapter as speech,
  openaiCompatibleTranscriptionAdapter as ear,
} from '../providers/openai-compatible.ts';
import { getSpeechAdapter, getTranscriptionAdapter } from '../registry.ts';
import { pcmToWav } from '../wav.ts';
import type { SpeechConnection } from '../speech-adapter.ts';

let server: FakeSpeechServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const conn = (address: string, apiKey = ''): SpeechConnection => ({
  apiKey,
  fetch: globalThis.fetch,
  baseURL: address,
});

/** A WAV a person could have said: what the turn sends. */
const SPOKEN = pcmToWav(
  new Uint8Array(3200).map((_, i) => i % 251),
  { sampleRate: 16_000 },
);

async function caught(p: Promise<unknown>): Promise<SpeechError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SpeechError) return err;
    throw err;
  }
  throw new Error('expected a SpeechError');
}

describe('openai-compatible transcription — the OpenAI multipart form @cap:parler-a-un-agent/moteur', () => {
  it('sends the audio as multipart `file` + `model`, nothing else, and returns the text', async () => {
    server = await startFakeSpeechServer({ transcript: 'Quelle heure est-il ?' });
    const r = await ear.transcribe(
      { audio: SPOKEN, mimeType: 'audio/wav', model: 'openai/whisper-large-v3-turbo' },
      conn(server.address),
    );
    expect(r.text).toBe('Quelle heure est-il ?');
    const sent = server.requests.find((q) => q.path === '/v1/audio/transcriptions')!;
    expect(sent.method).toBe('POST');
    expect(sent.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent.form!.fields).toEqual(['file', 'model']);
    expect(sent.form!.model).toBe('openai/whisper-large-v3-turbo');
    expect(sent.form!.file!.name).toBe('audio.wav');
    expect(sent.form!.file!.type).toBe('audio/wav');
    expect([...sent.form!.file!.bytes]).toEqual([...SPOKEN]);
    // No key given: no authorization header at all, never an invented one.
    expect(sent.headers['authorization']).toBeUndefined();
  });

  it('sends the key as a bearer token when the user gave one', async () => {
    server = await startFakeSpeechServer({ key: 'sk-local-123' });
    const r = await ear.transcribe(
      { audio: SPOKEN, mimeType: 'audio/wav', model: 'whisper-1' },
      conn(server.address, 'sk-local-123'),
    );
    expect(r.text).toBe('OK.');
    expect(server.requests.at(-1)!.headers['authorization']).toBe('Bearer sk-local-123');
  });

  it('a server that wants a key and gets none refuses, with its words and status', async () => {
    server = await startFakeSpeechServer({ key: 'sk-local-123' });
    const err = await caught(
      ear.transcribe(
        { audio: SPOKEN, mimeType: 'audio/wav', model: 'whisper-1' },
        conn(server.address),
      ),
    );
    expect(err.code).toBe('speech_provider_error');
    expect(err.status).toBe(401);
    expect(err.message).toContain('Invalid API key');
  });

  it('an address with or without a trailing slash reaches the same route', async () => {
    server = await startFakeSpeechServer();
    for (const address of [server.address, `${server.address}/`, `${server.address}//`]) {
      await ear.transcribe({ audio: SPOKEN, mimeType: 'audio/wav', model: 'm' }, conn(address));
    }
    expect(server.requests.map((q) => q.path)).toEqual([
      '/v1/audio/transcriptions',
      '/v1/audio/transcriptions',
      '/v1/audio/transcriptions',
    ]);
  });

  it('other words come back as they are: judging them is the caller’s', async () => {
    server = await startFakeSpeechServer({ transcript: 'Thank you.' });
    const r = await ear.transcribe(
      { audio: SPOKEN, mimeType: 'audio/wav', model: 'openai/whisper-tiny' },
      conn(server.address),
    );
    expect(r.text).toBe('Thank you.');
  });

  it('an empty transcript is "nothing heard", never an empty message', async () => {
    server = await startFakeSpeechServer({ transcript: '  ' });
    const err = await caught(
      ear.transcribe({ audio: SPOKEN, mimeType: 'audio/wav', model: 'm' }, conn(server.address)),
    );
    expect(err.code).toBe('speech_nothing_heard');
  });

  it('nothing listening at the address is speech_unreachable, with the address', async () => {
    const address = await closedServerAddress();
    const err = await caught(
      ear.transcribe({ audio: SPOKEN, mimeType: 'audio/wav', model: 'm' }, conn(address)),
    );
    expect(err.code).toBe('speech_unreachable');
    expect(err.message).toContain(address.replace('http://', ''));
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('lists the models the server names; a server without /models lists none', async () => {
    server = await startFakeSpeechServer({ models: ['openai/whisper-large-v3-turbo', 'tiny'] });
    expect(await ear.listModels!(conn(server.address))).toEqual([
      { id: 'openai/whisper-large-v3-turbo', label: 'openai/whisper-large-v3-turbo' },
      { id: 'tiny', label: 'tiny' },
    ]);
    await server.close();
    server = await startFakeSpeechServer({ models: 'none' });
    expect(await ear.listModels!(conn(server.address))).toEqual([]);
    expect(server.requests[0]!.path).toBe('/v1/models');
  });

  it('a refused /models is said, not read as "no models"', async () => {
    server = await startFakeSpeechServer({ key: 'k', models: ['m'] });
    const err = await caught(ear.listModels!(conn(server.address)));
    expect(err.code).toBe('speech_provider_error');
    expect(err.status).toBe(401);
  });

  it('binds without a key: a server the user runs may need none', () => {
    const bound = bindTranscription(ear, conn('http://127.0.0.1:1/v1'));
    expect(bound.provider).toBe('openai-compatible');
    expect(getTranscriptionAdapter('openai-compatible')).toBe(ear);
  });
});

describe('openai-compatible speech — the OpenAI speech surface @cap:parler-a-un-agent/moteur', () => {
  it('asks /audio/speech in JSON for WAV, and streams the bytes the server answered', async () => {
    server = await startFakeSpeechServer();
    const chunks: Uint8Array[] = [];
    const types = new Set<string>();
    for await (const c of speech.synthesizeStream!(
      { text: 'OK.', voiceId: 'af_heart', model: 'kokoro' },
      conn(server.address, 'sk-x'),
    )) {
      chunks.push(c.audio);
      types.add(c.mimeType);
    }
    const sent = server.requests.at(-1)!;
    expect(sent.path).toBe('/v1/audio/speech');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers['authorization']).toBe('Bearer sk-x');
    expect(sent.json).toEqual({
      model: 'kokoro',
      input: 'OK.',
      voice: 'af_heart',
      response_format: 'wav',
    });
    expect([...types]).toEqual(['audio/wav']);
    expect([...Buffer.concat(chunks)]).toEqual([...server.speechWav]);
  });

  it('one-shot synthesis returns the WAV as it is', async () => {
    server = await startFakeSpeechServer();
    const r = await bindSpeech(speech, conn(`${server.address}/`)).synthesize({
      text: 'Hello.',
      voiceId: 'v',
      model: 'm',
    });
    expect(r.mimeType).toBe('audio/wav');
    expect([...r.audio]).toEqual([...server.speechWav]);
    expect(server.requests.at(-1)!.headers['authorization']).toBeUndefined();
  });

  it('a voice the server refuses is said with its words', async () => {
    server = await startFakeSpeechServer({ speechStatus: 400 });
    const err = await caught(
      speech.synthesize({ text: 'OK.', voiceId: 'nobody', model: 'm' }, conn(server.address)),
    );
    expect(err.code).toBe('speech_provider_error');
    expect(err.message).toContain('voice not found');
  });

  it('nothing listening is speech_unreachable, for speaking exactly as for listening', async () => {
    const address = await closedServerAddress();
    const err = await caught(
      (async () => {
        for await (const _ of speech.synthesizeStream!(
          { text: 'OK.', voiceId: 'v', model: 'm' },
          conn(address),
        ))
          void _;
      })(),
    );
    expect(err.code).toBe('speech_unreachable');
    expect(getSpeechAdapter('openai-compatible')).toBe(speech);
  });

  it('lists the server’s models with no voices: servers do not list voices in a standard way', async () => {
    server = await startFakeSpeechServer({ models: ['kokoro'] });
    expect(await speech.listModels!(conn(server.address))).toEqual([
      { id: 'kokoro', label: 'kokoro', voices: [] },
    ]);
  });
});
