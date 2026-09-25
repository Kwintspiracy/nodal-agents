// resolve-speech.test.ts — which key the generate_speech tool speaks with (#487).
//
// Real database rows (encrypted like the dashboard stores them); the network
// is a stub, and the request that would leave is read back.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { entityLlmKeys, eq } from '@nodal-agents/db';
import { resolveSpeechGenerator } from '../../job/resolve-speech.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(entityLlmKeys).where(eq(entityLlmKeys.entityId, seed.entityId));
});

describe('resolveSpeechGenerator @cap:travailler-sur-des-fichiers/moteur', () => {
  it('no active OpenRouter key: no generator, so the tool says there is no key', async () => {
    await db.insert(entityLlmKeys).values([
      { entityId: seed.entityId, provider: 'anthropic', apiKey: encrypt('sk-ant') },
      {
        entityId: seed.entityId,
        provider: 'openrouter',
        apiKey: encrypt('sk-or-off'),
        isActive: false,
      },
    ]);

    expect(await resolveSpeechGenerator(db as never, seed.entityId)).toBeUndefined();
    expect(await resolveSpeechGenerator(db as never, null)).toBeUndefined();
  });

  it('speaks with the active OpenRouter key, decrypted, on OpenRouter /audio/speech', async () => {
    await db
      .insert(entityLlmKeys)
      .values({ entityId: seed.entityId, provider: 'openrouter', apiKey: encrypt('sk-or-live') });
    const sent: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
    });

    const speak = await resolveSpeechGenerator(db as never, seed.entityId);
    const audio = await speak!({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore' });

    expect(sent).toEqual([
      { url: 'https://openrouter.ai/api/v1/audio/speech', auth: 'Bearer sk-or-live' },
    ]);
    // The raw samples, behind the WAV header packages/llm adds.
    expect([...audio.bytes.subarray(44)]).toEqual([1, 2, 3]);
    expect(audio.mediaType).toBe('audio/wav');
  });

  it('a key that cannot be decrypted is said as such, not as "no key"', async () => {
    await db
      .insert(entityLlmKeys)
      .values({ entityId: seed.entityId, provider: 'openrouter', apiKey: 'not-a-ciphertext' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const speak = await resolveSpeechGenerator(db as never, seed.entityId);

    expect(speak).toBeDefined();
    await expect(
      speak!({ model: 'google/gemini-3.8-flash-tts', text: 'x', voice: 'Kore' }),
    ).rejects.toThrow('the workspace OpenRouter key could not be decrypted');
    warn.mockRestore();
  });
});
