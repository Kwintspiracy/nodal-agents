// voice-setting-repo.test.ts — la voix d'un espace est une LIGNE, pour tout
// espace, et se relit telle qu'écrite (#969).
//
// Le miroir de test (helpers.ts) porte le déclencheur de la migration 0158 :
// le retirer fait rougir le premier cas, qui crée un espace par le chemin le
// plus nu (un INSERT dans `entities`) et y lit la ligne. La migration réelle
// est prouvée contre un vrai Postgres par voice-setting-migration.pg.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { spinUpTestDb, type TestDb } from './helpers.ts';
import { readVoiceSetting, writeVoiceSetting } from '../repos/voice-setting.ts';
import { entities, entitySettings, users } from '../schema/index.ts';

let db: TestDb;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await spinUpTestDb());
});

afterAll(async () => {
  await pg.close();
});

async function newWorkspace(tag: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${tag}-${Date.now()}@example.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: tag, slug: `${tag}-${Date.now()}` })
    .returning();
  return entity!.id;
}

describe('the workspace voice setting @cap:parler-a-un-agent/moteur', () => {
  it('a workspace is born with the voice of before the setting, as a row in entity_settings', async () => {
    const entityId = await newWorkspace('voice-born');
    const rows = await db
      .select({ key: entitySettings.key, value: entitySettings.value })
      .from(entitySettings)
      .where(eq(entitySettings.entityId, entityId));
    expect(rows).toEqual([
      {
        key: 'voice',
        value:
          '{"source":"openrouter","model":"google/gemini-3.8-flash-tts","voice":"Kore","transcriptionSource":"openrouter","transcriptionModel":"x-ai/grok-stt-1.0"}',
      },
    ]);
    expect(await readVoiceSetting(db, entityId)).toEqual({
      ok: true,
      setting: {
        source: 'openrouter',
        model: 'google/gemini-3.8-flash-tts',
        voice: 'Kore',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
  });

  it('reads back what was written, for this workspace only', async () => {
    const a = await newWorkspace('voice-a');
    const b = await newWorkspace('voice-b');
    await writeVoiceSetting(db, a, {
      source: 'openrouter',
      model: 'x-ai/grok-voice-tts-1.0',
      voice: 'leo',
      transcriptionSource: 'openrouter',
      transcriptionModel: 'x-ai/grok-stt-1.0',
    });
    expect(await readVoiceSetting(db, a)).toEqual({
      ok: true,
      setting: {
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
    expect(await readVoiceSetting(db, b)).toEqual({
      ok: true,
      setting: {
        source: 'openrouter',
        model: 'google/gemini-3.8-flash-tts',
        voice: 'Kore',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      },
    });
  });

  it('a missing row is said as missing, never read as a voice', async () => {
    const entityId = await newWorkspace('voice-missing');
    await db
      .delete(entitySettings)
      .where(and(eq(entitySettings.entityId, entityId), eq(entitySettings.key, 'voice')));
    expect(await readVoiceSetting(db, entityId)).toEqual({
      ok: false,
      code: 'voice_setting_missing',
    });
  });

  it('a row of another shape is said as unreadable, with what is wrong', async () => {
    const entityId = await newWorkspace('voice-bad');
    await db
      .update(entitySettings)
      .set({ value: '{"source":"elsewhere","model":"m","voice":"v"}' })
      .where(and(eq(entitySettings.entityId, entityId), eq(entitySettings.key, 'voice')));
    const read = await readVoiceSetting(db, entityId);
    expect(read.ok).toBe(false);
    expect(read).toMatchObject({ code: 'voice_setting_unreadable' });
    expect((read as { detail: string }).detail).toMatch(/^voice_setting_unreadable: source /);
  });

  it('refuses to write a value it could not read back', async () => {
    const entityId = await newWorkspace('voice-refuse');
    await expect(
      writeVoiceSetting(db, entityId, {
        source: 'openrouter',
        model: '',
        voice: 'leo',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      }),
    ).rejects.toThrow();
    expect(await readVoiceSetting(db, entityId)).toMatchObject({
      ok: true,
      setting: { model: 'google/gemini-3.8-flash-tts' },
    });
  });

  // #1048: a part served by a server the user runs carries its address and,
  // when there is one, its key AT REST (the enc:v1: blob), never in clear.
  it('reads back a server part with its key at rest, and refuses a key in clear', async () => {
    const entityId = await newWorkspace('voice-server');
    const atRest = 'enc:v1:aXY=:dGFn:Y3Q=';
    await writeVoiceSetting(db, entityId, {
      source: 'openai-compatible',
      model: 'kokoro',
      voice: 'af_heart',
      speechServer: { address: 'http://127.0.0.1:8880/v1/' },
      transcriptionSource: 'openai-compatible',
      transcriptionModel: 'openai/whisper-large-v3-turbo',
      transcriptionServer: { address: 'http://127.0.0.1:8786/v1', key: atRest },
    });
    expect(await readVoiceSetting(db, entityId)).toEqual({
      ok: true,
      setting: {
        source: 'openai-compatible',
        model: 'kokoro',
        voice: 'af_heart',
        // One form enters the database: the trailing slash is gone.
        speechServer: { address: 'http://127.0.0.1:8880/v1' },
        transcriptionSource: 'openai-compatible',
        transcriptionModel: 'openai/whisper-large-v3-turbo',
        transcriptionServer: { address: 'http://127.0.0.1:8786/v1', key: atRest },
      },
    });
    await expect(
      writeVoiceSetting(db, entityId, {
        source: 'openrouter',
        model: 'm',
        voice: 'v',
        transcriptionSource: 'openai-compatible',
        transcriptionModel: 'w',
        transcriptionServer: { address: 'http://127.0.0.1:8786/v1', key: 'sk-in-clear' },
      }),
    ).rejects.toThrow();
    // A server part with no address, or an address for a keyed source, is not a setting.
    await expect(
      writeVoiceSetting(db, entityId, {
        source: 'openai-compatible',
        model: 'm',
        voice: 'v',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'w',
      }),
    ).rejects.toThrow(/speechServer/);
  });
});
