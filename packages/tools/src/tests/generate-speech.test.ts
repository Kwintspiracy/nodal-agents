// generate-speech.test.ts — text in, a WAV file in the agent's folders (#487).
//
// Real folders on disk. The speech is either a stub standing for the bound
// adapter the runner builds on the OpenRouter key, or that real adapter of
// packages/speech over a stubbed connection (#940). What is read back: the
// file's bytes, where it landed, and the reason the agent gets when it cannot.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindSpeech,
  getSpeechAdapter,
  type BoundSpeech,
  type SynthesizeRequest,
} from '@nodal-agents/speech';
import { generateSpeechTool, GenerateSpeechInputSchema } from '../builtin/generate-speech';
import type { ToolContext, ToolSpeech } from '../types';

let WORKSPACE: string;
let OUTSIDE: string;

beforeEach(async () => {
  // Le chemin RÉEL : l'outil rend celui que `realpath` donne, et sous Windows
  // le dossier temporaire peut porter un nom court 8.3 (`RUNNER~1` sur la CI
  // Windows, au lieu de `runneradmin`). Sans cela, le chemin rendu ne se compare
  // plus au chemin attendu, et la CI Windows était rouge depuis #488.
  WORKSPACE = await realpath(await mkdtemp(join(tmpdir(), 'nodal-speech-ws-')));
  OUTSIDE = await realpath(await mkdtemp(join(tmpdir(), 'nodal-speech-outside-')));
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

/** A minimal WAV: RIFF header then two samples. */
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

/** A bound speech that answers `audio` (or throws `error`) for every request. */
function fakeSpeech(
  answer: { audio?: Uint8Array; error?: Error; mimeType?: 'audio/wav' | 'audio/mpeg' } = {},
): {
  calls: SynthesizeRequest[];
  speech: BoundSpeech;
} {
  const calls: SynthesizeRequest[] = [];
  const adapter = getSpeechAdapter('openrouter');
  const speech: BoundSpeech = {
    provider: adapter.provider,
    capabilities: adapter.capabilities,
    listVoices: async () => [],
    synthesize: async (request) => {
      calls.push(request);
      if (answer.error) throw answer.error;
      return { audio: answer.audio ?? WAV, mimeType: answer.mimeType ?? 'audio/wav', latencyMs: 0 };
    },
  };
  return { calls, speech };
}

function recorder() {
  return fakeSpeech();
}

/** The voice of before #969: what every workspace holds until someone chooses. */
const FIRST = {
  source: 'openrouter',
  model: 'google/gemini-3.8-flash-tts',
  voice: 'Kore',
} as const;

/** What the runner hands the tool: the workspace's voice setting, and its bound adapter. */
function voiced(
  speech: BoundSpeech,
  setting: { source: 'openrouter' | 'google'; model: string; voice: string } = FIRST,
): ToolSpeech {
  return { ok: true, voice: { ...setting, speech } };
}

const input = (fields: Record<string, unknown>) => GenerateSpeechInputSchema.parse(fields);

describe('generate_speech @cap:travailler-sur-des-fichiers/moteur', () => {
  it('writes the audio the generator returns into the folder, and passes model, voice and style', async () => {
    const { calls, speech } = recorder();

    const res = await generateSpeechTool.execute(
      input({
        text: 'Bonjour Quentin.',
        path: 'audio/intro.wav',
        voice: 'Puck',
        style: 'warm and friendly',
      }),
      ctx({ speech: voiced(speech) }),
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
        voiceId: 'Puck',
        style: 'warm and friendly',
      },
    ]);
  });

  // #969. Mutation verified: `input.model ?? workspace.model` replaced by
  // the old written default (the first Gemini model, Kore) → red.
  it("with no model nor voice, speaks with the workspace's voice setting, and adds .wav to a bare name", async () => {
    for (const setting of [
      { source: 'openrouter', model: 'x-ai/grok-voice-tts-1.0', voice: 'leo' },
      FIRST,
    ] as const) {
      const { calls, speech } = recorder();
      const res = await generateSpeechTool.execute(
        input({ text: 'x', path: 'note' }),
        ctx({ speech: voiced(speech, setting) }),
      );
      expect(res).toMatchObject({
        ok: true,
        path: join(WORKSPACE, 'note.wav'),
        model: setting.model,
        voice: setting.voice,
      });
      expect(calls).toEqual([{ model: setting.model, text: 'x', voiceId: setting.voice }]);
    }
  });

  it('explicit model and voice win over the setting', async () => {
    const { calls, speech } = recorder();
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav', model: 'deepgram/aura-2', voice: 'aura-2-thalia-en' }),
      ctx({
        speech: voiced(speech, {
          source: 'openrouter',
          model: 'x-ai/grok-voice-tts-1.0',
          voice: 'leo',
        }),
      }),
    );
    expect(res).toMatchObject({ ok: true, model: 'deepgram/aura-2', voice: 'aura-2-thalia-en' });
    expect(calls).toEqual([{ model: 'deepgram/aura-2', text: 'x', voiceId: 'aura-2-thalia-en' }]);
  });

  it('never writes outside the agent folders', async () => {
    const { calls, speech } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: join(OUTSIDE, 'escape.wav') }),
      ctx({ speech: voiced(speech) }),
    );

    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses another extension: the file is WAV', async () => {
    const { calls, speech } = recorder();

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'audio/intro.mp3' }),
      ctx({ speech: voiced(speech) }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'The file is WAV: "audio/intro.mp3" must end in .wav (or have no extension).',
    });
    expect(calls).toEqual([]);
  });

  it("says which key is missing for the workspace's voice, and writes nothing", async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav' }),
      ctx({ speech: { ok: false, code: 'voice_key_missing', source: 'google' } }),
    );
    expect(res).toEqual({
      ok: false,
      reason:
        'No active Google key in this workspace, and its voice (Settings, Voice) speaks through ' +
        'Google. Tell the owner to add one in Settings, LLM keys, or to choose another voice.',
    });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();

    const none = await generateSpeechTool.execute(input({ text: 'x', path: 'a.wav' }), ctx());
    expect(none).toEqual({
      ok: false,
      reason: 'Speech is not available in this run: no voice was given to it.',
    });
  });

  it('reports the provider error and writes nothing', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav' }),
      ctx({
        speech: voiced(fakeSpeech({ error: new Error('400: unknown voice "Nobody"') }).speech),
      }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'Speech generation failed: 400: unknown voice "Nobody"',
    });
    await mkdir(WORKSPACE, { recursive: true });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();
  });

  // #969: the model is no longer one of a list written in the code; an unknown
  // one is the vendor's to refuse, and its words reach the agent (below).
  it('refuses text longer than the model takes, and an empty model, at the schema', () => {
    expect(() => input({ text: 'x'.repeat(5_001), path: 'a.wav' })).toThrow();
    expect(() => input({ text: 'x', path: 'a.wav', model: '' })).toThrow();
  });

  // Review of PR #488 (Reviewer C, minor findings).
  it('an answer that is not a WAV file is refused, and nothing is written', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav' }),
      ctx({
        speech: voiced(
          fakeSpeech({
            audio: new TextEncoder().encode('{"error":{"message":"upstream"}}'),
          }).speech,
        ),
      }),
    );

    expect(res).toEqual({
      ok: false,
      reason: 'google/gemini-3.8-flash-tts answered, but not with audio. Nothing was written.',
    });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();
  });

  // #969. Mutation verified: the container check removed → red (the reason says
  // the model did not answer with audio, which is false).
  it('a model that answers mp3 is said as such, and nothing is written', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav' }),
      ctx({
        speech: voiced(
          fakeSpeech({ audio: Uint8Array.from([0xff, 0xfb, 0x90, 0x64]), mimeType: 'audio/mpeg' })
            .speech,
          { source: 'openrouter', model: 'minimax/speech-2.8-turbo', voice: 'English_CalmWoman' },
        ),
      }),
    );
    expect(res).toEqual({
      ok: false,
      reason:
        'minimax/speech-2.8-turbo answered audio/mpeg, and this tool writes WAV files. Nothing was written.',
    });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();
  });

  it('writes .WAV as .wav', async () => {
    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'audio/INTRO.WAV' }),
      ctx({ speech: voiced(fakeSpeech().speech) }),
    );

    expect(res.ok && res.path).toBe(join(WORKSPACE, 'audio', 'INTRO.wav'));
    expect([...(await readFile(join(WORKSPACE, 'audio', 'INTRO.wav')))]).toEqual([...WAV]);
  });

  // #940: the tool speaks through the OpenRouter SpeechAdapter of
  // packages/speech, the one speech path. Here that real adapter, bound to a
  // stubbed connection, produces the file: what is checked is the request that
  // left and the WAV that landed on disk, header field by header field.
  it('writes the WAV the OpenRouter SpeechAdapter builds from the samples OpenRouter answered', async () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    const sent: Array<{ url: string; body: unknown }> = [];
    const speech = bindSpeech(getSpeechAdapter('openrouter'), {
      apiKey: 'sk-or-test',
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(pcm, { headers: { 'content-type': 'audio/pcm;rate=24000' } });
      },
    });

    const res = await generateSpeechTool.execute(
      input({ text: 'Bonjour.', path: 'audio/hello.wav', style: 'calm' }),
      ctx({ speech: voiced(speech) }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(sent).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/audio/speech',
        body: {
          model: 'google/gemini-3.8-flash-tts',
          input: 'Bonjour.',
          voice: 'Kore',
          response_format: 'pcm',
          provider: { options: { 'google-ai-studio': { speech_metadata: { style: 'calm' } } } },
        },
      },
    ]);
    const file = new Uint8Array(await readFile(join(WORKSPACE, 'audio', 'hello.wav')));
    const view = new DataView(file.buffer, file.byteOffset);
    const tag = (o: number) => String.fromCharCode(...file.subarray(o, o + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(36 + pcm.length);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.length);
    expect([...file.subarray(44)]).toEqual([...pcm]);
    expect(res.bytes).toBe(44 + pcm.length);
  });

  it('a provider refusal through the adapter reaches the agent with the vendor’s words', async () => {
    const speech = bindSpeech(getSpeechAdapter('openrouter'), {
      apiKey: 'sk-or-test',
      fetch: async () =>
        Response.json({ error: { message: 'Unknown voice "Nobody"' } }, { status: 400 }),
    });

    const res = await generateSpeechTool.execute(
      input({ text: 'x', path: 'a.wav', voice: 'Nobody' }),
      ctx({ speech: voiced(speech) }),
    );

    expect(res).toEqual({
      ok: false,
      reason:
        'Speech generation failed: openrouter google/gemini-3.8-flash-tts: HTTP 400 — Unknown voice "Nobody"',
    });
    await expect(readFile(join(WORKSPACE, 'a.wav'))).rejects.toThrow();
  });
});
