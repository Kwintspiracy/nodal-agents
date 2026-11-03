// resolve-voice.test.ts — the ONE resolution of the voice every door speaks
// with (#969; before it, #487 and #940 spoke with the first OpenRouter model
// and the voice Kore, written in the code).
//
// Real database rows (encrypted like the dashboard stores them): the
// workspace's voice setting, and its keys. The provider transport of
// packages/llm (`providerFetch`, #608) is replaced by a recorder: a speech that
// left through any other fetch would not reach it, and these tests would fail.
// What is asserted is the request that leaves — URL, key, body, voice.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, entityLlmKeys, entitySettings, eq, writeVoiceSetting } from '@nodal-agents/db';
import type { VoiceSourceChoices } from '@nodal-agents/shared';
import {
  clearVoiceCatalog,
  resolveVoice,
  voiceChoices,
  voiceRefusal,
  VOICE_CATALOG_TTL_MS,
} from '../../job/resolve-voice.ts';

type Sent = { url: string; auth: string | null; googKey: string | null; body: unknown };
const sent: Sent[] = [];
const pcmAnswer = (): Response =>
  new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { 'content-type': 'audio/pcm' },
  });
let answer: (url: string) => Response = pcmAnswer;

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      sent.push({
        url: String(input),
        auth: headers.get('authorization'),
        googKey: headers.get('x-goog-api-key'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return answer(String(input));
    },
  };
});

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

const FIRST = {
  source: 'openrouter',
  model: 'google/gemini-3.8-flash-tts',
  voice: 'Kore',
} as const;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

afterEach(async () => {
  sent.length = 0;
  answer = pcmAnswer;
  clearVoiceCatalog();
  vi.unstubAllGlobals();
  await db.delete(entityLlmKeys).where(eq(entityLlmKeys.entityId, seed.entityId));
  await writeVoiceSetting(db as never, seed.entityId, FIRST);
});

async function key(provider: string, plain: string, extra: { baseUrl?: string } = {}) {
  await db
    .insert(entityLlmKeys)
    .values({ entityId: seed.entityId, provider, apiKey: encrypt(plain), ...extra });
}

describe('resolveVoice @cap:parler-a-un-agent/moteur', () => {
  it('a new workspace speaks with the voice of before the setting, on its OpenRouter key and the provider transport', async () => {
    await key('openrouter', 'sk-or-live');
    vi.stubGlobal('fetch', () => {
      throw new Error('the global fetch was used: speech left the provider transport (#608)');
    });

    const r = await resolveVoice(db as never, seed.entityId);
    if (!r.ok) throw new Error(r.code);
    expect([r.voice.source, r.voice.model, r.voice.voice]).toEqual([
      'openrouter',
      'google/gemini-3.8-flash-tts',
      'Kore',
    ]);
    await r.voice.speech.synthesize({ model: r.voice.model, text: 'x', voiceId: r.voice.voice });
    expect(sent).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/audio/speech',
        auth: 'Bearer sk-or-live',
        googKey: null,
        body: {
          model: 'google/gemini-3.8-flash-tts',
          input: 'x',
          voice: 'Kore',
          response_format: 'pcm',
        },
      },
    ]);
  });

  // Mutation verified: `resolveVoice` speaking the first value instead of the
  // row it read → red.
  it('speaks with the stored source, model and voice — and the next read sees a change, no restart', async () => {
    await key('openrouter', 'sk-or-live');
    await key('google', 'AIza-live');
    await writeVoiceSetting(db as never, seed.entityId, {
      source: 'openrouter',
      model: 'x-ai/grok-voice-tts-1.0',
      voice: 'leo',
    });
    const grok = await resolveVoice(db as never, seed.entityId);
    if (!grok.ok) throw new Error(grok.code);
    await grok.voice.speech.synthesize({
      model: grok.voice.model,
      text: 'x',
      voiceId: grok.voice.voice,
    });
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      [
        'https://openrouter.ai/api/v1/audio/speech',
        { model: 'x-ai/grok-voice-tts-1.0', input: 'x', voice: 'leo', response_format: 'pcm' },
      ],
    ]);

    await writeVoiceSetting(db as never, seed.entityId, {
      source: 'google',
      model: 'gemini-3.8-flash-tts',
      voice: 'Puck',
    });
    const google = await resolveVoice(db as never, seed.entityId);
    if (!google.ok) throw new Error(google.code);
    expect([google.voice.source, google.voice.speech.provider, google.voice.voice]).toEqual([
      'google',
      'google',
      'Puck',
    ]);
    expect(google.voice.speech.capabilities.streamOutput).toBe('audio/pcm');
  });

  it('a source with no key is said with its name, never another source in its place', async () => {
    await key('openrouter', 'sk-or-live');
    await writeVoiceSetting(db as never, seed.entityId, {
      source: 'google',
      model: 'gemini-3.8-flash-tts',
      voice: 'Kore',
    });
    expect(await resolveVoice(db as never, seed.entityId)).toEqual({
      ok: false,
      code: 'voice_key_missing',
      source: 'google',
    });
    expect(sent).toEqual([]);
  });

  it('a key that cannot be decrypted is said as such, not as "no key"', async () => {
    await db
      .insert(entityLlmKeys)
      .values({ entityId: seed.entityId, provider: 'openrouter', apiKey: 'not-a-ciphertext' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await resolveVoice(db as never, seed.entityId);
    expect(r).toMatchObject({ ok: false, code: 'voice_key_undecryptable', source: 'openrouter' });
    warn.mockRestore();
  });

  it('a missing setting row is said, never replaced by a voice', async () => {
    await key('openrouter', 'sk-or-live');
    await db
      .delete(entitySettings)
      .where(and(eq(entitySettings.entityId, seed.entityId), eq(entitySettings.key, 'voice')));
    expect(await resolveVoice(db as never, seed.entityId)).toEqual({
      ok: false,
      code: 'voice_setting_missing',
    });
  });

  it('a base URL stored with an OpenRouter key is where the speech goes', async () => {
    await key('openrouter', 'sk-or-proxy', { baseUrl: 'https://proxy.example/api/v1' });
    const r = await resolveVoice(db as never, seed.entityId);
    if (!r.ok) throw new Error(r.code);
    await r.voice.speech.synthesize({ model: r.voice.model, text: 'x', voiceId: r.voice.voice });
    expect(sent.map((s) => s.url)).toEqual(['https://proxy.example/api/v1/audio/speech']);
  });
});

describe('voiceChoices and voiceRefusal @cap:parler-a-un-agent/moteur', () => {
  const OR_MODELS = {
    data: [
      { id: 'x-ai/grok-voice-tts-1.0', name: 'Grok Voice', supported_voices: ['eve', 'leo'] },
      { id: 'fish-audio/s1', name: 'Fish Audio: S1', supported_voices: null },
    ],
  };

  // Mutation verified: the TTL check removed (always listed again) → red.
  it('each source says what it offers, or why it cannot; the list is kept one hour, a failure never', async () => {
    await key('openrouter', 'sk-or-live');
    let listed = 0;
    answer = (url) => {
      if (url.includes('/models')) {
        listed++;
        return new Response(JSON.stringify(OR_MODELS));
      }
      throw new Error(`unexpected ${url}`);
    };
    let t = Date.parse('2026-11-03T10:00:00Z');
    const now = () => t;

    const first = await voiceChoices(db as never, seed.entityId, now);
    expect(first).toEqual([
      {
        source: 'openrouter',
        state: 'available',
        models: [
          {
            id: 'x-ai/grok-voice-tts-1.0',
            label: 'Grok Voice',
            voices: [
              { id: 'eve', label: 'eve' },
              { id: 'leo', label: 'leo' },
            ],
          },
          { id: 'fish-audio/s1', label: 'Fish Audio: S1', voices: [] },
        ],
        listedAt: '2026-11-03T10:00:00.000Z',
        cacheSeconds: 3600,
      },
      { source: 'google', state: 'unavailable', code: 'voice_key_missing' },
    ]);
    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/models?output_modalities=speech');

    t += VOICE_CATALOG_TTL_MS - 1;
    await voiceChoices(db as never, seed.entityId, now);
    expect(listed).toBe(1);
    t += 2;
    await voiceChoices(db as never, seed.entityId, now);
    expect(listed).toBe(2);

    clearVoiceCatalog();
    answer = () => new Response('{"error":{"message":"down"}}', { status: 503 });
    const down = await voiceChoices(db as never, seed.entityId, now);
    expect(down[0]).toEqual({
      source: 'openrouter',
      state: 'unavailable',
      code: 'voice_catalog_unreachable',
      detail: 'openrouter models: HTTP 503 — down',
    });
    answer = () => new Response(JSON.stringify(OR_MODELS));
    expect((await voiceChoices(db as never, seed.entityId, now))[0]!.state).toBe('available');
  });

  // Mutation verified: the voice check removed from `voiceRefusal` → red.
  it('a model the source does not serve, or a voice the model does not offer, is refused with its code', () => {
    const choices: VoiceSourceChoices[] = [
      {
        source: 'openrouter',
        state: 'available',
        models: [
          { id: 'x-ai/grok-voice-tts-1.0', label: 'Grok', voices: [{ id: 'leo', label: 'leo' }] },
          { id: 'fish-audio/s1', label: 'Fish', voices: [] },
        ],
        listedAt: '2026-11-03T10:00:00.000Z',
        cacheSeconds: 3600,
      },
      { source: 'google', state: 'unavailable', code: 'voice_key_missing' },
    ];
    const grok = (voice: string) =>
      voiceRefusal({ source: 'openrouter', model: 'x-ai/grok-voice-tts-1.0', voice }, choices);
    expect(grok('leo')).toBeNull();
    expect(grok('Kore')).toEqual({
      code: 'voice_not_offered',
      source: 'openrouter',
      detail: 'x-ai/grok-voice-tts-1.0 offers leo',
    });
    expect(
      voiceRefusal({ source: 'openrouter', model: 'fish-audio/s1', voice: 'any' }, choices),
    ).toEqual({
      code: 'voice_not_offered',
      source: 'openrouter',
      detail: 'fish-audio/s1 offers no voice',
    });
    expect(
      voiceRefusal({ source: 'openrouter', model: 'nobody/tts', voice: 'leo' }, choices),
    ).toEqual({ code: 'voice_model_not_offered', source: 'openrouter', detail: 'nobody/tts' });
    expect(
      voiceRefusal({ source: 'google', model: 'gemini-3.8-flash-tts', voice: 'Kore' }, choices),
    ).toEqual({ code: 'voice_key_missing', source: 'google' });
  });
});
