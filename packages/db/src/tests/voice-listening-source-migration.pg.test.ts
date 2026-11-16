// voice-listening-source-migration.pg.test.ts — migration 0167 contre un VRAI Postgres.
//
// CE QUE CELA PROUVE (#1048) :
//   - un espace créé après la migration naît avec la source qui écoute ;
//   - une ligne `voice` d'avant (0160) gagne `transcriptionSource: openrouter`
//     sans que le reste bouge, et se RELIT comme un réglage (`readVoiceSetting`)
//     — les lignes existantes continuent de marcher ; une ligne qui porte déjà
//     une source (un serveur de la personne) n'est pas réécrite ; une ligne qui
//     ne se lit pas comme du JSON reste telle quelle ;
//   - l'entrée du journal existe ;
//   - UNE BASE PUBLIÉE (0.9.10 : 0164 et 0166, aucune migration de la voix) :
//     le migrateur applique 0167 LUI-MÊME, `findMigrationGaps` est vide (donc
//     `nodal-agents up` ne refuse pas de servir) ;
//   - une base qui avait appliqué le premier jet (0165) avant 0166, la pile de
//     démonstration : 0167 s'y applique sans erreur, sans trou, sans toucher
//     aux lignes qui portent déjà leur source.
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
    new URL('../../migrations/0167_voice_listening_source.sql', import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('migration 0167_voice_listening_source @cap:parler-a-un-agent/moteur', () => {
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
    expect(journal.default.entries.map((e) => e.tag)).toContain('0167_voice_listening_source');
  });
});

// ─── Une base qui a déjà vécu ───────────────────────────────────────────────
//
// 0.9.10 a publié 0166 SANS la migration de la voix. Si celle-ci avait gardé
// son premier numéro (0165, `when` sous celui de 0166), le migrateur de drizzle
// l'aurait sautée en silence sur toute installation 0.9.10, et `nodal-agents
// up` aurait refusé de servir (#298). Elle porte donc le numéro suivant (0167)
// et un `when` APRÈS 0166 : ici, on rejoue ce qui est ARRIVÉ à ces bases — un
// migrateur drizzle applique un dossier dont le journal est celui d'avant, puis
// le VRAI migrateur de cette branche passe dessus, comme le fait `up` après la
// mise à jour.

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const WHEN_0166 = 1_786_437_200_000;
const WHEN_0167 = 1_786_437_300_000;
/** Le numéro et le `when` du premier jet, que la pile de démonstration a appliqués. */
const FIRST_DRAFT = { idx: 165, when: 1_786_437_100_000, tag: '0165_voice_listening_source' };

interface JournalFile {
  entries: Array<{ idx: number; when: number; tag: string }>;
}

const tmpFolders: string[] = [];
afterAll(() => {
  for (const f of tmpFolders) rmSync(f, { recursive: true, force: true });
});

/**
 * Une copie des migrations dont le journal est celui d'une base qui a vécu :
 * sans les entrées `drop`, avec en plus `add` (le fichier de la voix, recopié
 * sous son ancien nom). Les `vector(N)` sont réécrits en `text`, comme le fait
 * `up` sur une machine sans pgvector.
 */
function migrationsAsItWas(opts: {
  drop: string[];
  add?: { idx: number; when: number; tag: string };
}): string {
  const dest = mkdtempSync(join(tmpdir(), 'voice-0167-migrations-'));
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
  const kept = journal.entries.filter((e) => !opts.drop.includes(e.tag));
  expect(kept).toHaveLength(journal.entries.length - opts.drop.length);
  if (opts.add) {
    // The first draft's file: the same SQL, under the number it first had.
    writeFileSync(
      join(dest, `${opts.add.tag}.sql`),
      readFileSync(join(dest, '0167_voice_listening_source.sql'), 'utf8'),
    );
    kept.push(opts.add);
    kept.sort((a, b) => a.when - b.when);
  }
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

describe('migration 0167 on a database that already lived @cap:parler-a-un-agent/moteur', () => {
  // Mutation verified: the journal entry given a `when` below 0166's (the first
  // draft's 1786437100000) → red: the migrator skips it, the row stays without
  // its source, and `findMigrationGaps` names it.
  it('a 0.9.10 database (0164 and 0166, no voice migration): the branch applies it ITSELF, no gap is left, so `up` does not refuse', async () => {
    const url = await databaseMigratedWith(
      'published_0910',
      migrationsAsItWas({ drop: ['0167_voice_listening_source'] }),
    );
    expect(await historyWhens(url)).toContain(WHEN_0166);
    expect(await historyWhens(url)).not.toContain(WHEN_0167);

    const { db, close } = createClient(url, { max: 1 });
    try {
      // A person's workspace as 0.9.10 left it: a voice row without the ear's
      // source.
      const entityId = await newEntity(db);
      const before = (await voiceOf(db, entityId)) as Record<string, unknown>;
      expect(before).not.toHaveProperty('transcriptionSource');

      await runMigrations(url, { patchVectorAsText: true });

      expect(await voiceOf(db, entityId)).toEqual({ ...before, transcriptionSource: 'openrouter' });
      expect(await readVoiceSetting(db, entityId)).toMatchObject({ ok: true });
      expect(await historyWhens(url)).toContain(WHEN_0167);
      // The check `up` runs after the migrator finds nothing to refuse on.
      expect(await findMigrationGaps(url, { patchVectorAsText: true })).toEqual([]);
      expect(await repairMigrations(url, { patchVectorAsText: true })).toEqual([]);

      // A workspace created after is born with the full value.
      const born = await newEntity(db);
      expect(await voiceOf(db, born)).toMatchObject({ transcriptionSource: 'openrouter' });
    } finally {
      await close();
    }
  }, 180_000);

  // Mutation verified: the SQL's backfill made to rewrite rows that carry the
  // field already → the server row changes and this case goes red.
  it('a database that applied the first draft (0165) before 0166: 0167 applies without error, no gap, rows already carrying their source are untouched', async () => {
    const url = await databaseMigratedWith(
      'demo_first_draft',
      migrationsAsItWas({
        drop: ['0166_tool_call_read_only_hint', '0167_voice_listening_source'],
        add: FIRST_DRAFT,
      }),
    );
    expect(await historyWhens(url)).toContain(FIRST_DRAFT.when);
    expect(await historyWhens(url)).not.toContain(WHEN_0166);

    const { db, close } = createClient(url, { max: 1 });
    try {
      const serverEntity = await newEntity(db);
      const serverValue = JSON.stringify({
        source: 'openrouter',
        model: 'x-ai/grok-voice-tts-1.0',
        voice: 'leo',
        transcriptionSource: 'openai-compatible',
        transcriptionModel: 'openai/whisper-large-v3-turbo',
        transcriptionServer: { address: 'http://127.0.0.1:8786/v1' },
      });
      await setVoice(db, serverEntity, serverValue);
      // A row the first draft already gave its source, read back as is.
      const listening = await newEntity(db);
      const listeningBefore = await voiceOf(db, listening);
      expect(listeningBefore).toMatchObject({ transcriptionSource: 'openrouter' });
      const updatedAt = async (id: string) =>
        (
          await rows<{ updated_at: unknown }>(
            db,
            sql`SELECT updated_at FROM entity_settings WHERE entity_id = ${id} AND key = 'voice'`,
          )
        )[0]!.updated_at;
      const stamps = [await updatedAt(serverEntity), await updatedAt(listening)];
      const historyBefore = await historyWhens(url);

      await runMigrations(url, { patchVectorAsText: true });

      // 0166 and 0167 follow, the ordinary way; the first draft's row stays,
      // and the journal no longer announces it, so it is no gap.
      expect(await historyWhens(url)).toEqual([...historyBefore, WHEN_0166, WHEN_0167]);
      expect(await voiceOf(db, serverEntity)).toEqual(JSON.parse(serverValue));
      expect(await voiceOf(db, listening)).toEqual(listeningBefore);
      expect([await updatedAt(serverEntity), await updatedAt(listening)]).toEqual(stamps);
      expect(await findMigrationGaps(url, { patchVectorAsText: true })).toEqual([]);
      expect(await repairMigrations(url, { patchVectorAsText: true })).toEqual([]);
    } finally {
      await close();
    }
  }, 180_000);
});
