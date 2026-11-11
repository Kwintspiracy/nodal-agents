// voice-setting-migration.pg.test.ts — migration 0158 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#969) :
//   - un espace créé après la migration naît avec sa ligne `voice`, la voix
//     d'avant le réglage ;
//   - un espace d'AVANT la migration (sa ligne absente) la reçoit quand la
//     migration passe, et une voix déjà choisie n'est jamais réécrite ;
//   - l'entrée du journal existe : sans elle drizzle-kit ignorerait le fichier
//     en silence (CLAUDE.md, « Ajouter une migration »).
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
  const tag = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

async function voiceOf(db: Db, entityId: string): Promise<string[]> {
  const r = await rows<{ value: string }>(
    db,
    sql`SELECT value FROM entity_settings WHERE entity_id = ${entityId} AND key = 'voice'`,
  );
  return r.map((x) => x.value);
}

/** The first value as 0158 wrote it; 0160 (#976) adds the transcription model to it, 0165 (#1048) its source. */
const FIRST = '{"source":"openrouter","model":"google/gemini-3.8-flash-tts","voice":"Kore"}';
const FIRST_WITH_EAR =
  '{"source":"openrouter","model":"google/gemini-3.8-flash-tts","voice":"Kore","transcriptionSource":"openrouter","transcriptionModel":"x-ai/grok-stt-1.0"}';

/** Le fichier de la migration, rejoué tel quel : ce que drizzle-kit exécute. */
function migrationStatements(): string[] {
  const path = fileURLToPath(new URL('../../migrations/0158_voice_setting.sql', import.meta.url));
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('migration 0158_voice_setting @cap:parler-a-un-agent/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a workspace created after the migration is born with the voice of before the setting', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const entityId = await newEntity(db);
      // Every migration applied: the first value carries the ear of 0160 and its source (0165).
      expect(await voiceOf(db, entityId)).toEqual([FIRST_WITH_EAR]);
    } finally {
      await close();
    }
  });

  it('a workspace of before the migration receives its row; a chosen voice is kept', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const before = await newEntity(db);
      await db.execute(
        sql`DELETE FROM entity_settings WHERE entity_id = ${before} AND key = 'voice'`,
      );
      const chosen = await newEntity(db);
      const leo = '{"source":"openrouter","model":"x-ai/grok-voice-tts-1.0","voice":"leo"}';
      await db.execute(
        sql`UPDATE entity_settings SET value = ${leo} WHERE entity_id = ${chosen} AND key = 'voice'`,
      );

      for (const statement of migrationStatements()) await db.execute(sql.raw(statement));

      expect(await voiceOf(db, before)).toEqual([FIRST]);
      expect(await voiceOf(db, chosen)).toEqual([leo]);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0158_voice_setting');
  });
});
