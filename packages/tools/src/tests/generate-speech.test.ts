// generate-speech.test.ts — text in, an mp3 file in the agent's folders (#487).
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

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3]);

function recorder() {
  const calls: SpeechRequest[] = [];
  const speechGenerator = async (request: SpeechRequest) => {
    calls.push(request);
    return { bytes: MP3, mediaType: 'audio/mp3' };
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
        path: 'audio/intro.mp3',
        voice: 'Puck',
        style: 'warm and friendly',
      }),
      ctx({ speechGenerator }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.path).toBe(join(WORKSPACE, 'audio', 'intro.mp3'));
    expect([...(await readFile(res.path))]).toEqual([...MP3]);
    expect(res.bytes).toBe(MP3.byteLength);
    expect(calls).toEqual([
      {
        model: 'google/gemini-3.8-flash-tts',
        text: 'Bonjour Quentin.',
        voice: 'Puck',
        style: 'warm and friendly',
      },
    ]);
  });

  it('defaults to Gemini 3.8 Flash TTS and the voice Kore, and adds .mp3 to a bare name', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'note' }),
      ctx({ speechGenerator }),
    );

    expect(res.ok && res.path).toBe(join(WORKSPACE, 'note.mp3'));
    expect(calls[0]).toEqual({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore' });
  });

  it('never writes outside the agent folders', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: join(OUTSIDE, 'escape.mp3') }),
      ctx({ speechGenerator }),
    );

    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses another extension: the file is mp3', async () => {
    const { calls, speechGenerator } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'audio/intro.wav' }),
      ctx({ speechGenerator }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'The file is mp3: "audio/intro.wav" must end in .mp3 (or have no extension).',
    });
    expect(calls).toEqual([]);
  });

  it('says there is no OpenRouter key when the runner provided no generator', async () => {
    const res = await generateSpeechTool.execute(input({ text: 'x', path: 'a.mp3' }), ctx());

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toContain('No active OpenRouter key in this workspace');
  });

  it('reports the provider error and writes nothing', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.mp3' }),
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
    await expect(readFile(join(WORKSPACE, 'a.mp3'))).rejects.toThrow();
  });

  it('refuses text longer than the model takes, and an unknown model, at the schema', () => {
    expect(() => input({ text: 'x'.repeat(5_001), path: 'a.mp3' })).toThrow();
    expect(() => input({ text: 'x', path: 'a.mp3', model: 'openai/gpt-5' })).toThrow();
  });
});
