// resolve-speech.test.ts — which key the generate_speech tool speaks with, and
// through which path (#487, #940).
//
// Real database rows (encrypted like the dashboard stores them). The provider
// transport of packages/llm (`providerFetch`, #608) is replaced by a recorder:
// a speech that left through any other fetch (the global one, or a second
// speech path with its own) would not reach it, and these tests would fail.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys, eq } from '@nodal-agents/db';
import { resolveSpeech } from '../../job/resolve-speech.ts';

const sent: Array<{ url: string; auth: string | null; body: unknown }> = [];

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sent.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
    },
  };
});

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

afterEach(async () => {
  sent.length = 0;
  vi.unstubAllGlobals();
  await db.delete(entityLlmKeys).where(eq(entityLlmKeys.entityId, seed.entityId));
});

describe('resolveSpeech @cap:travailler-sur-des-fichiers/moteur', () => {
  it('no active OpenRouter key: no speech, so the tool says there is no key', async () => {
    await db.insert(entityLlmKeys).values([
      { entityId: seed.entityId, provider: 'anthropic', apiKey: encrypt('sk-ant') },
      {
        entityId: seed.entityId,
        provider: 'openrouter',
        apiKey: encrypt('sk-or-off'),
        isActive: false,
      },
    ]);

    expect(await resolveSpeech(db as never, seed.entityId)).toBeUndefined();
    expect(await resolveSpeech(db as never, null)).toBeUndefined();
  });

  it('speaks with the active OpenRouter key, decrypted, through the OpenRouter SpeechAdapter on the provider transport', async () => {
    await db
      .insert(entityLlmKeys)
      .values({ entityId: seed.entityId, provider: 'openrouter', apiKey: encrypt('sk-or-live') });
    vi.stubGlobal('fetch', () => {
      throw new Error('the global fetch was used: speech left the provider transport (#608)');
    });

    const speech = await resolveSpeech(db as never, seed.entityId);
    const audio = await speech!.synthesize({
      model: 'google/gemini-3.8-flash-tts',
      text: 'x',
      voiceId: 'Kore',
    });

    expect(speech!.provider).toBe('openrouter');
    expect(sent).toEqual([
      {
        url: 'https://openrouter.ai/api/v1/audio/speech',
        auth: 'Bearer sk-or-live',
        body: {
          model: 'google/gemini-3.8-flash-tts',
          input: 'x',
          voice: 'Kore',
          response_format: 'pcm',
        },
      },
    ]);
    // The raw samples, behind the WAV header packages/speech adds.
    expect([...audio.audio.subarray(44)]).toEqual([1, 2, 3, 4]);
    expect(audio.mimeType).toBe('audio/wav');
  });

  it('a base URL stored with the key is where the speech goes', async () => {
    await db.insert(entityLlmKeys).values({
      entityId: seed.entityId,
      provider: 'openrouter',
      apiKey: encrypt('sk-or-proxy'),
      baseUrl: 'https://proxy.example/api/v1',
    });

    const speech = await resolveSpeech(db as never, seed.entityId);
    await speech!.synthesize({ text: 'x', voiceId: 'Kore' });

    expect(sent.map((s) => s.url)).toEqual(['https://proxy.example/api/v1/audio/speech']);
  });

  it('a key that cannot be decrypted is said as such, not as "no key"', async () => {
    await db
      .insert(entityLlmKeys)
      .values({ entityId: seed.entityId, provider: 'openrouter', apiKey: 'not-a-ciphertext' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const speech = await resolveSpeech(db as never, seed.entityId);

    expect(speech).toBeDefined();
    await expect(
      speech!.synthesize({ model: 'google/gemini-3.8-flash-tts', text: 'x', voiceId: 'Kore' }),
    ).rejects.toThrow('the workspace OpenRouter key could not be decrypted');
    expect(sent).toEqual([]);
    warn.mockRestore();
  });
});
