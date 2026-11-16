// voice-listening-source-migration.pg.test.ts — migration 0165 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#1048) :
//   - un espace créé après la migration naît avec la source qui écoute ;
//   - une ligne `voice` d'avant (0160) gagne `transcriptionSource: openrouter`
//     sans que le reste bouge, et se RELIT comme un réglage (`readVoiceSetting`)
//     — les lignes existantes continuent de marcher ; une ligne qui porte déjà
//     une source (un serveur de la personne) n'est pas réécrite ; une ligne qui
//     ne se lit pas comme du JSON reste telle quelle ;
//   - l'entrée du journal existe ;
//   - UNE BASE PUBLIÉE (0.9.10 : 0164 et 0166 appliquées, JAMAIS 0165) : le
//     migrateur de drizzle saute 0165 en silence (son `when` est sous la
//     dernière ligne d'historique), `findMigrationGaps` la nomme, et
//     `repairMigrations` la pose ET l'enregistre (#298) ;
//   - une base qui a appliqué 0165 AVANT 0166 (la pile de démonstration) reste
//     telle quelle : ni trou, ni réécriture, ni seconde ligne d'historique.
//
// Le démarrage est un TEST, pas un `beforeAll` (invariant #4).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, readVoiceSetting, sql } from '@nodal-agents/db';
import { runMigrations, findMigrationGaps, repairMigrations } from '@nodal-agents/db/migrate';

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
  const tag = `ear-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    new URL('../../migrations/0165_voice_listening_source.sql', import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('migration 0165_voice_listening_source @cap:parler-a-un-agent/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('a workspace created after the migration is born with the source that listens', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const entityId = await newEntity(db);
      expect(await voiceOf(db, entityId)).toEqual({
        source: 'openrouter',
        model: 'google/gemini-3.8-flash-tts',
        voice: 'Kore',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'x-ai/grok-stt-1.0',
      });
      expect(await readVoiceSetting(db, entityId)).toMatchObject({ ok: true });
    } finally {
      await close();
    }
  });

  // Mutation verified: the backfill DO block removed → red (the 0160 row has
  // no source for its ear, and `readVoiceSetting` says it unreadable).
  it('a row of 0160 gains its source and is read again as a setting; a server row and an unreadable row are left alone', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const old = await newEntity(db);
      await setVoice(
        db,
        old,
        '{"source":"google","model":"gemini-3.8-flash-tts","voice":"Umbriel","transcriptionModel":"openai/gpt-transcribe"}',
      );
      const server = await newEntity(db);
      const serverValue = JSON.stringify({
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionSource: 'openai-compatible',
        transcriptionModel: 'openai/whisper-large-v3-turbo',
        transcriptionServer: { address: 'http://127.0.0.1:8786/v1' },
      });
      await setVoice(db, server, serverValue);
      const broken = await newEntity(db);
      await setVoice(db, broken, 'not json');

      for (const statement of migrationStatements()) await db.execute(sql.raw(statement));

      expect(await voiceOf(db, old)).toEqual({
        source: 'google',
        model: 'gemini-3.8-flash-tts',
        voice: 'Umbriel',
        transcriptionSource: 'openrouter',
        transcriptionModel: 'openai/gpt-transcribe',
      });
      expect(await readVoiceSetting(db, old)).toEqual({
        ok: true,
        setting: {
          source: 'google',
          model: 'gemini-3.8-flash-tts',
          voice: 'Umbriel',
          transcriptionSource: 'openrouter',
          transcriptionModel: 'openai/gpt-transcribe',
        },
      });
      expect(await voiceOf(db, server)).toEqual(JSON.parse(serverValue));
      expect(await voiceOf(db, broken)).toBe('not json');
      expect(await readVoiceSetting(db, broken)).toMatchObject({
        ok: false,
        code: 'voice_setting_unreadable',
      });
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    expect(journal.default.entries.map((e) => e.tag)).toContain('0165_voice_listening_source');
  });
});

// ─── Une base qui a déjà vécu, avec ou sans 0165 ────────────────────────────
//
// On ne simule pas « un trou » en défaisant 0165 à la main : on rejoue ce qui
// est ARRIVÉ. Un migrateur drizzle applique un dossier dont le journal est
// celui de `main` à la 0.9.10 (0166 présente, 0165 absente), puis le VRAI
// migrateur de cette branche passe dessus : c'est ce que fait un
// `nodal-agents up` après la mise à jour.

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const WHEN_0165 = 1_786_437_100_000;
const WHEN_0166 = 1_786_437_200_000;

interface JournalFile {
  entries: Array<{ idx: number; when: number; tag: string }>;
}

const tmpFolders: string[] = [];
afterAll(() => {
  for (const f of tmpFolders) rmSync(f, { recursive: true, force: true });
});

/**
 * Une copie des migrations dont le journal ne porte pas `sansTag` : le journal
 * qu'avait `main` avant cette branche, ou avant 0166. Les `vector(N)` sont
 * réécrits en `text`, comme le fait `up` sur une machine sans pgvector.
 */
function migrationsWithout(sansTag: string): string {
  const dest = mkdtempSync(join(tmpdir(), 'voice-0165-migrations-'));
  tmpFolders.push(dest);
  mkdirSync(join(dest, 'meta'), { recursive: true });
  for (const f of readdirSync(MIGRATIONS)) {
    if (!f.endsWith('.sql')) continue;
    const contenu = readFileSync(join(MIGRATIONS, f), 'utf8').replace(/\bvector\(\d+\)/g, 'text');
    writeFileSync(join(dest, f), contenu);
  }
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as JournalFile;
  const kept = journal.entries.filter((e) => e.tag !== sansTag);
  expect(kept).toHaveLength(journal.entries.length - 1);
  writeFileSync(
    join(dest, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  return dest;
}

/** Une base neuve sur le même Postgres, migrée avec le dossier donné. */
async function databaseMigratedWith(name: string, folder: string): Promise<string> {
  const admin = postgres(harness().url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(harness().url);
  url.pathname = `/${name}`;
  const target = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(target), { migrationsFolder: folder });
  } finally {
    await target.end();
  }
  return url.toString();
}

async function historyWhens(url: string): Promise<number[]> {
  const { db, close } = createClient(url, { max: 1 });
  try {
    const r = await rows<{ created_at: string | number }>(
      db,
      sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    return r.map((l) => Number(l.created_at));
  } finally {
    await close();
  }
}

describe('migration 0165 on a database that already lived @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: `repairMigrations` made a no-op → the later assertions
  // of this case go red (no transcriptionSource, no history row, gap stays).
  it('a 0.9.10 database (0164 and 0166, never 0165): the migrator skips 0165, the gap check names it, the repair lays it and records it', async () => {
    const url = await databaseMigratedWith(
      'published_0910',
      migrationsWithout('0165_voice_listening_source'),
    );
    expect(await historyWhens(url)).not.toContain(WHEN_0165);
    expect(await historyWhens(url)).toContain(WHEN_0166);

    const { db, close } = createClient(url, { max: 1 });
    try {
      // A person's workspace as 0.9.10 left it: a voice row without the ear's
      // source.
      const entityId = await newEntity(db);
      const before = (await voiceOf(db, entityId)) as Record<string, unknown>;
      expect(before).not.toHaveProperty('transcriptionSource');

      // The branch's real migrator runs: silent, and 0165 is NOT applied.
      await runMigrations(url, { patchVectorAsText: true });
      expect(await voiceOf(db, entityId)).toEqual(before);
      expect(await historyWhens(url)).not.toContain(WHEN_0165);

      // The check names it, by journal timestamp.
      expect(await findMigrationGaps(url, { patchVectorAsText: true })).toEqual([
        { idx: 165, tag: '0165_voice_listening_source', when: WHEN_0165 },
      ]);

      // The repair lays it, records it, and the row is read again as a setting.
      const repaired = await repairMigrations(url, { patchVectorAsText: true });
      expect(repaired.map((g) => g.tag)).toEqual(['0165_voice_listening_source']);
      expect(await voiceOf(db, entityId)).toEqual({ ...before, transcriptionSource: 'openrouter' });
      expect(await readVoiceSetting(db, entityId)).toMatchObject({ ok: true });
      expect(await historyWhens(url)).toContain(WHEN_0165);
      expect(await findMigrationGaps(url, { patchVectorAsText: true })).toEqual([]);

      // A workspace created after is born with the full value.
      const born = await newEntity(db);
      expect(await voiceOf(db, born)).toMatchObject({ transcriptionSource: 'openrouter' });

      // A second repair does nothing: no second history row.
      expect(await repairMigrations(url, { patchVectorAsText: true })).toEqual([]);
      expect((await historyWhens(url)).filter((w) => w === WHEN_0165)).toHaveLength(1);
    } finally {
      await close();
    }
  }, 180_000);

  // Mutation verified: `gapsBetween` made to report 0165 even when its history
  // row exists → both cases go red (a phantom gap on a healthy database).
  it('a database that applied 0165 BEFORE 0166 stays as it is: no gap, nothing rewritten, no second history row', async () => {
    const url = await databaseMigratedWith(
      'demo_0165_first',
      migrationsWithout('0166_tool_call_read_only_hint'),
    );
    expect(await historyWhens(url)).toContain(WHEN_0165);
    expect(await historyWhens(url)).not.toContain(WHEN_0166);

    const { db, close } = createClient(url, { max: 1 });
    try {
      const entityId = await newEntity(db);
      const serverValue = JSON.stringify({
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionSource: 'openai-compatible',
        transcriptionModel: 'openai/whisper-large-v3-turbo',
        transcriptionServer: { address: 'http://127.0.0.1:8786/v1' },
      });
      await setVoice(db, entityId, serverValue);
      const historyBefore = await historyWhens(url);

      await runMigrations(url, { patchVectorAsText: true });

      // 0166 follows, the ordinary way; 0165 keeps its single history row.
      expect(await historyWhens(url)).toEqual([...historyBefore, WHEN_0166]);
      expect(await voiceOf(db, entityId)).toEqual(JSON.parse(serverValue));
      expect(await findMigrationGaps(url, { patchVectorAsText: true })).toEqual([]);
      expect(await repairMigrations(url, { patchVectorAsText: true })).toEqual([]);
      expect(await voiceOf(db, entityId)).toEqual(JSON.parse(serverValue));
    } finally {
      await close();
    }
  }, 180_000);
});
