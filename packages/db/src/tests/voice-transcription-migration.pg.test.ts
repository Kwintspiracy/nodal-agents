// voice-transcription-migration.pg.test.ts — migration 0160 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#976) :
//   - un espace créé après la migration naît avec le modèle qui écoute ;
//   - une ligne `voice` d'avant (0158) gagne `transcriptionModel` sans que le
//     reste bouge ; une ligne qui le porte déjà n'est pas réécrite ; une ligne
//     qui ne se lit pas comme du JSON reste telle quelle (elle se dira
//     illisible), et ne fait pas échouer la migration ;
//   - l'entrée du journal existe.
//
// Le démarrage est un TEST, pas un `beforeAll` (invariant #4).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

type Db = ReturnType<typeof createClient>['db'];

async function rows<T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[];
}

async function newEntity(db: Db): Promise<string> {
  const tag = `ear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const u = await rows<{ id: string }>(
    db,
    sql`INSERT INTO users (email) VALUES (${`${tag}@example.com`}) RETURNING id`,
  );
  const e = await rows<{ id: string }>(
    db,
    sql`INSERT INTO entities (user_id, name, slug) VALUES (${u[0]!.id}, ${tag}, ${tag}) RETURNING id`,
  );
  return e[0]!.id;
}

async function voiceOf(db: Db, entityId: string): Promise<unknown> {
  const r = await rows<{ value: string }>(
    db,
    sql`SELECT value FROM entity_settings WHERE entity_id = ${entityId} AND key = 'voice'`,
  );
  try {
    return JSON.parse(r[0]!.value) as unknown;
  } catch {
    return r[0]!.value;
  }
}

async function setVoice(db: Db, entityId: string, value: string): Promise<void> {
  await db.execute(
    sql`UPDATE entity_settings SET value = ${value} WHERE entity_id = ${entityId} AND key = 'voice'`,
  );
}

function migrationStatements(): string[] {
  const path = fileURLToPath(
    new URL('../../migrations/0160_voice_transcription.sql', import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('migration 0160_voice_transcription @cap:parler-a-un-agent/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a workspace created after the migration is born with the ear', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      expect(await voiceOf(db, await newEntity(db))).toEqual({
        source: 'openrouter',
        model: 'google/gemini-3.8-flash-tts',
        voice: 'Kore',
        // 0165 (#1048), applied with every migration, names the ear's source.
        transcriptionSource: 'openrouter',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      });
    } finally {
      await close();
    }
  });

  // Mutation verified: the backfill DO block removed → red (the 0158 row
  // keeps no ear, and would then be read as unreadable).
  it('a row of 0158 gains the ear and keeps its voice; a chosen ear and an unreadable row are left alone', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const old = await newEntity(db);
      await setVoice(
        db,
        old,
        '{"source":"openrouter","model":"x-ai/grok-voice-tts-1.0","voice":"leo"}',
      );
      const chosen = await newEntity(db);
      const chosenValue =
        '{"source":"openrouter","model":"x-ai/grok-voice-tts-1.0","voice":"leo","transcriptionModel":"openai/gpt-transcribe"}';
      await setVoice(db, chosen, chosenValue);
      const broken = await newEntity(db);
      await setVoice(db, broken, 'not json');

      for (const statement of migrationStatements()) await db.execute(sql.raw(statement));

      expect(await voiceOf(db, old)).toEqual({
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      });
      expect(await voiceOf(db, chosen)).toEqual(JSON.parse(chosenValue));
      expect(await voiceOf(db, broken)).toBe('not json');
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0160_voice_transcription');
  });
});
