// generate-speech.test.ts — text in, a WAV file in the agent's folders (#487).
//
// Real folders on disk; the speech generator is a stub standing for the one
// the runner builds on the OpenRouter key. What is read back: the file's bytes,
// where it landed, and the reason the agent gets when it cannot.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechRequest } from '@nodal-agents/llm';
import { generateSpeechTool, GenerateSpeechInputSchema } from '../builtin/generate-speech';
import type { ToolContext } from '../types';

let WORKSPACE: string;
let OUTSIDE: string;

beforeEach(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'nodal-speech-ws-'));
  OUTSIDE = await mkdtemp(join(tmpdir(), 'nodal-speech-outside-'));
});

afterAll(async () => {
  await rm(WORKSPACE, { recursive: true, force: true }).catch(() => {});
  await rm(OUTSIDE, { recursive: true, force: true }).catch(() => {});
});

const noProjectsDb = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as ToolContext['db'];

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: '00000000-0000-0000-0000-000000000aaa',
    agentId: '00000000-0000-0000-0000-000000000bbb',
    entityId: '00000000-0000-0000-0000-000000000ccc',
    db: noProjectsDb,
    jobChatId: null,
    workspaces: [{ label: 'ws', path: WORKSPACE }],
    ...overrides,
  };
}

/** A minimal WAV: RIFF header then two samples, as packages/llm builds it. */
const WAV = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode('WAVE'),
  1,
  0,
  2,
  0,
]);

function recorder() {
  const calls: SpeechRequest[] = [];
  const speechGenerator = async (request: SpeechRequest) => {
    calls.push(request);
    return { bytes: WAV, mediaType: 'audio/wav' };
  };
  return { calls, speechGenerator };
}

const input = (fields: Record<string, unknown>) => GenerateSpeechInputSchema.parse(fields);

describe('generate_speech @cap:travailler-sur-des-fichiers/moteur', () => {
  it('writes the audio the generator returns into the folder, and passes model, voice and style', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({
        text: 'Bonjour Quentin.',
        path: 'audio/intro.wav',
        voice: 'Puck',
        style: 'warm and friendly',
      }),
      ctx({ speechGenerator }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.path).toBe(join(WORKSPACE, 'audio', 'intro.wav'));
    expect([...(await readFile(res.path))]).toEqual([...WAV]);
    expect(res.bytes).toBe(WAV.byteLength);
    expect(calls).toEqual([
      {
        model: 'google/gemini-3.8-flash-tts',
        text: 'Bonjour Quentin.',
        voice: 'Puck',
        style: 'warm and friendly',
      },
    ]);
  });

  it('defaults to Gemini 3.8 Flash TTS and the voice Kore, and adds .wav to a bare name', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'note' }),
      ctx({ speechGenerator }),
    );

    expect(res.ok && res.path).toBe(join(WORKSPACE, 'note.wav'));
    expect(calls[0]).toEqual({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore' });
  });

  it('never writes outside the agent folders', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: join(OUTSIDE, 'escape.wav') }),
      ctx({ speechGenerator }),
    );

    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses another extension: the file is WAV', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'audio/intro.mp3' }),
      ctx({ speechGenerator }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'The file is WAV: "audio/intro.mp3" must end in .wav (or have no extension).',
    });
    expect(calls).toEqual([]);
  });

  it('says there is no OpenRouter key when the runner provided no generator', async () => {
    const res = await generateSpeechTool.execute(input({ text: 'x', path: 'a.wav' }), ctx());

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('No active OpenRouter key in this workspace');
  });

  it('reports the provider error and writes nothing', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav' }),
      ctx({
        speechGenerator: async () => {
          throw new Error('400: unknown voice "Nobody"');
        },
      }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'Speech generation failed: 400: unknown voice "Nobody"',
    });
    await mkdir(WORKSPACE, { recursive: true });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();
  });

  it('refuses text longer than the model takes, and an unknown model, at the schema', () => {
    expect(() => input({ text: 'x'.repeat(5_001), path: 'a.wav' })).toThrow();
    expect(() => input({ text: 'x', path: 'a.wav', model: 'openai/gpt-5' })).toThrow();
  });

  // Review of PR #488 (Reviewer C, minor findings).
  it('an answer that is not a WAV file is refused, and nothing is written', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav' }),
      ctx({
        speechGenerator: async () => ({
          bytes: new TextEncoder().encode('{"error":{"message":"upstream"}}'),
          mediaType: 'audio/wav',
        }),
      }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'google/gemini-3.8-flash-tts answered, but not with audio. Nothing was written.',
    });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();
  });

  it('writes .WAV as .wav', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'audio/INTRO.WAV' }),
      ctx({ speechGenerator: async () => ({ bytes: WAV, mediaType: 'audio/wav' }) }),
    );

    expect(res.ok && res.path).toBe(join(WORKSPACE, 'audio', 'INTRO.wav'));
    expect([...(await readFile(join(WORKSPACE, 'audio', 'INTRO.wav')))]).toEqual([...WAV]);
  });
});
