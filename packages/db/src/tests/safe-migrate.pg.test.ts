// safe-migrate.pg.test.ts — the schema never moves without a copy, and a
// program never opens a database it is older than. On a VRAI Postgres.
//
// @cap:installer-et-demarrer/moteur
//
// Every case runs `migrateDatabase`, the one function `up` (and `--dev`,
// `--repair-migrations`, the restart `update` launches) migrates through,
// against a real cluster: the copy is a real `CREATE DATABASE … TEMPLATE`, the
// swap real renames, the migrator Drizzle's own. The journals are built here,
// in a temporary folder, so each case controls exactly what is pending, what
// fails and what a "newer" program knows; the last group runs the REAL
// journal, with the vector patch `up` uses without pgvector.
//
// The state files live in a temporary folder too (a config and a master key
// of the right shapes): nothing here reads or writes a real Nodal home.

import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { NODAL_CONFIG_FILE } from '@nodal-agents/shared/nodal-config-file';
import { MASTER_KEY_FILE } from '@nodal-agents/secrets';
import {
  migrateDatabase,
  MigrationFailedError,
  MigrationGapError,
  type MigrateDatabaseOptions,
} from '../safe-migrate.ts';
import {
  DatabaseNewerThanProgramError,
  readOpenedBy,
  SCHEMA_OPENED_BY_SETTING,
} from '../schema-state.ts';
import {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  SnapshotError,
  type SnapshotStateFiles,
} from '../snapshots.ts';
import { readProgramJournal } from '../migrate.ts';

// ─── Journals built for the cases ────────────────────────────────────────────

interface Migration {
  readonly tag: string;
  readonly when: number;
  readonly sql: string;
}

const M = {
  base: {
    tag: '0000_base',
    when: 1_700_000_000_000,
    sql: `CREATE TABLE app_settings (key text PRIMARY KEY, value text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL, data jsonb);`,
  },
  // Its FIRST statement creates a table; its second counts the copies of this
  // database that exist at that moment. A copy taken before the migration
  // started has no `seen` table and the count is 1.
  seen: {
    tag: '0001_seen',
    when: 1_700_000_100_000,
    sql: `CREATE TABLE seen (copies integer NOT NULL);
--> statement-breakpoint
INSERT INTO seen SELECT count(*) FROM pg_database WHERE starts_with(datname, current_database() || '_snap_');`,
  },
  // Destructive, and it succeeds: what a faulty release would ship.
  destroy: {
    tag: '0002_destroy',
    when: 1_700_000_200_000,
    sql: `DELETE FROM notes WHERE id > 1;
--> statement-breakpoint
ALTER TABLE notes DROP COLUMN data;`,
  },
  more: {
    tag: '0003_more',
    when: 1_700_000_300_000,
    sql: `CREATE TABLE more_things (id integer);`,
  },
  evenMore: {
    tag: '0004_even_more',
    when: 1_700_000_400_000,
    sql: `CREATE TABLE even_more (id integer);`,
  },
  fails: {
    tag: '0003_fails',
    when: 1_700_000_300_000,
    sql: `CREATE TABLE half_done (id integer);
--> statement-breakpoint
SELECT 1 / 0;`,
  },
} satisfies Record<string, Migration>;

const scratch = mkdtempSync(join(tmpdir(), 'nodal-safe-migrate-'));

/** A migrations folder holding exactly `migrations`, with its journal. */
function program(...migrations: Migration[]): string {
  const folder = join(scratch, `program-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const m of migrations) writeFileSync(join(folder, `${m.tag}.sql`), m.sql);
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: migrations.map((m, idx) => ({
        idx,
        version: '7',
        when: m.when,
        tag: m.tag,
        breakpoints: true,
      })),
    }),
  );
  return folder;
}

/** A home's state files, of the right shapes, in a folder of their own. */
function stateFiles(): SnapshotStateFiles & { configPath: string; keyPath: string } {
  const home = join(scratch, `home-${randomBytes(4).toString('hex')}`);
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');
  const keyPath = join(home, 'secrets.key');
  writeFileSync(
    configPath,
    JSON.stringify({
      ports: { web: 3000, runner: 3001, postgres: 25432 },
      workerSecret: randomBytes(24).toString('hex'),
    }),
  );
  writeFileSync(keyPath, randomBytes(32).toString('base64'));
  return {
    dir: join(home, 'snapshots'),
    configPath,
    keyPath,
    files: [
      { name: 'config.json', path: configPath, spec: NODAL_CONFIG_FILE, boundToDatabase: false },
      { name: 'secrets.key', path: keyPath, spec: MASTER_KEY_FILE, boundToDatabase: true },
    ],
  };
}

// ─── The databases ───────────────────────────────────────────────────────────

const opened: RealPostgres[] = [];

afterAll(async () => {
  for (const pg of opened) {
    // The copies first: the harness only drops the database it created.
    for (const s of await listSnapshots(pg.url, scratch).catch(() => [])) {
      await withSql(maintenance(pg.url), (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS "${s.name}" WITH (FORCE)`),
      ).catch(() => undefined);
    }
    await pg.stop();
  }
});

async function freshDatabase(): Promise<string> {
  const pg = await startRealPostgres();
  opened.push(pg);
  return pg.url;
}

function urlOf(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function maintenance(url: string): string {
  return urlOf(url, 'postgres');
}

async function withSql<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** Every row of `notes`, as JSON, in id order: the content, not a count. */
async function notes(url: string): Promise<unknown[]> {
  return withSql(url, async (sql) => [...(await sql`SELECT * FROM notes ORDER BY id`)]);
}

async function history(url: string): Promise<number[]> {
  return withSql(url, async (sql) =>
    (
      await sql<
        { created_at: string }[]
      >`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
    ).map((r) => Number(r.created_at)),
  );
}

async function tableExists(url: string, table: string): Promise<boolean> {
  return withSql(url, async (sql) => {
    const [r] = await sql<
      { ok: boolean }[]
    >`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS ok`;
    return r?.ok === true;
  });
}

let clock = Date.UTC(2026, 10, 28, 12, 0, 0);
/** A strictly increasing clock: two copies never share a name. */
function tick(): Date {
  clock += 1_000;
  return new Date(clock);
}

/** The options `up` passes for the REAL journal: the bundled folder, vectors as text. */
function realOptions(files: SnapshotStateFiles): MigrateDatabaseOptions {
  return {
    patchVectorAsText: true,
    repair: false,
    programVersion: '9.9.9',
    keep: 2,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stateFiles: files,
    now: tick,
  };
}

function options(
  folder: string,
  files: SnapshotStateFiles,
  over: Partial<MigrateDatabaseOptions> = {},
): MigrateDatabaseOptions {
  return {
    migrationsFolder: folder,
    repair: false,
    programVersion: '9.9.9',
    keep: 2,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stateFiles: files,
    now: tick,
    ...over,
  };
}

/** A database at `0000_base` with three notes: an install one migration behind. */
async function installAtBase(files: SnapshotStateFiles): Promise<string> {
  const url = await freshDatabase();
  await migrateDatabase(url, options(program(M.base), files));
  await withSql(
    url,
    (sql) =>
      sql`INSERT INTO notes (id, body, data) VALUES
          (1, 'first', '{"k": 1}'), (2, 'second', '{"k": [2, 3]}'), (3, 'troisième', null)`,
  );
  return url;
}

// ─── The cases ───────────────────────────────────────────────────────────────

describe('migrateDatabase: a copy before the schema moves @cap:installer-et-demarrer/moteur', () => {
  it('rows and a pending migration: the copy exists BEFORE the migration, holds the same rows, state files beside it', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const before = await notes(url);

    const result = await migrateDatabase(url, options(program(M.base, M.seen), files));

    expect(result.applied).toEqual(['0001_seen']);
    const snap = result.snapshot;
    expect(snap).not.toBeNull();
    expect(snap!.name).toMatch(/_snap_\d{17}_0000$/);
    expect(snap!.meta).toMatchObject({
      kind: 'before-migration',
      lastMigration: '0000_base',
      madeBy: '9.9.9',
      lastOpenedBy: '9.9.9',
      stateFiles: ['config.json', 'secrets.key'],
    });

    // Taken before the migration's first statement: the copy has no `seen`,
    // and the migration's second statement already saw one copy.
    const copyUrl = urlOf(url, snap!.name);
    expect(await tableExists(copyUrl, 'seen')).toBe(false);
    expect(await withSql(url, async (sql) => [...(await sql`SELECT copies FROM seen`)])).toEqual([
      { copies: 1 },
    ]);

    // The same rows, compared by content.
    expect(await notes(copyUrl)).toEqual(before);
    // The state files, byte for byte.
    expect(readFileSync(join(snap!.stateDir, 'config.json'), 'utf-8')).toBe(
      readFileSync(files.configPath, 'utf-8'),
    );
    expect(readFileSync(join(snap!.stateDir, 'secrets.key'), 'utf-8')).toBe(
      readFileSync(files.keyPath, 'utf-8'),
    );

    // The version that opened it is recorded.
    expect(await readOpenedBy(url)).toMatchObject({ version: '9.9.9', lastMigration: '0001_seen' });
  }, 120_000);

  it('a destructive migration that succeeds: going back returns the rows exactly, the replaced database is kept', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const before = await notes(url);

    const result = await migrateDatabase(url, options(program(M.base, M.destroy), files));
    expect(await notes(url)).toEqual([{ id: 1, body: 'first' }]);

    const back = await restoreSnapshot(url, result.snapshot!.name, {
      at: tick(),
      madeBy: '9.9.9',
      stateFiles: files,
      currentLastMigration: '0002_destroy',
      currentOpenedBy: '9.9.9',
    });
    expect(await notes(url)).toEqual(before);
    // Nothing dropped: the destroyed state is a copy of its own, described.
    expect(back.replaced.meta).toMatchObject({
      kind: 'replaced-by-rollback',
      lastMigration: '0002_destroy',
    });
    expect(await notes(urlOf(url, back.replaced.name))).toEqual([{ id: 1, body: 'first' }]);
    const names = (await listSnapshots(url, files.dir)).map((s) => s.name);
    expect(names).toContain(back.replaced.name);
    expect(names).not.toContain(result.snapshot!.name); // it IS the database now
  }, 120_000);

  it('a migration that fails: refused with the copy named, the copy intact, going back gives identical rows', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const before = await notes(url);
    const historyBefore = await history(url);

    const err = await migrateDatabase(url, options(program(M.base, M.fails), files)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MigrationFailedError);
    const snap = (err as MigrationFailedError).snapshot!;
    expect((err as Error).message).toContain(snap.name);
    expect((err as Error).message).toContain('division by zero');

    expect(await notes(urlOf(url, snap.name))).toEqual(before);
    expect(await history(url)).toEqual(historyBefore);

    await restoreSnapshot(url, snap.name, {
      at: tick(),
      madeBy: '9.9.9',
      stateFiles: files,
      currentLastMigration: '0000_base',
      currentOpenedBy: '9.9.9',
    });
    expect(await notes(url)).toEqual(before);
    expect(await tableExists(url, 'half_done')).toBe(false);
  }, 120_000);
});

describe('migrateDatabase: no copy, no migration @cap:installer-et-demarrer/moteur', () => {
  it('another session holds the database: no copy, NO migration, the message says why', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const historyBefore = await history(url);
    const holder = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await holder`SELECT 1`;
      const err = await migrateDatabase(url, options(program(M.base, M.seen), files)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SnapshotError);
      expect((err as SnapshotError).code).toBe('SNAPSHOT_SOURCE_IN_USE');
      expect((err as Error).message).toMatch(/another session is connected to it \(pid \d+/);
    } finally {
      await holder.end();
    }
    expect(await history(url)).toEqual(historyBefore);
    expect(await tableExists(url, 'seen')).toBe(false);
    expect(await listSnapshots(url, files.dir)).toEqual([]);
    // No state folder was left behind for a copy that was never made.
    expect(existsSync(files.dir) ? readdirSync(files.dir) : []).toEqual([]);
  }, 120_000);

  it('not enough disk (injected): no copy, NO migration, the numbers in the message', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const historyBefore = await history(url);

    const err = await migrateDatabase(
      url,
      options(program(M.base, M.seen), files, { freeBytes: () => 10 * 1024 * 1024 }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SnapshotError);
    expect((err as SnapshotError).code).toBe('SNAPSHOT_NO_SPACE');
    expect((err as Error).message).toMatch(/takes \d+(\.\d)? MB, and as much again/);
    expect((err as Error).message).toMatch(/MB must be free, and 10\.0 MB are/);

    expect(await history(url)).toEqual(historyBefore);
    expect(await tableExists(url, 'seen')).toBe(false);
    expect(await listSnapshots(url, files.dir)).toEqual([]);
  }, 120_000);

  it('nothing pending: no copy; a fresh database: migrated, no copy', async () => {
    const files = stateFiles();
    const fresh = await freshDatabase();
    const first = await migrateDatabase(fresh, options(program(M.base, M.seen), files));
    expect(first.snapshot).toBeNull();
    expect(first.applied).toEqual(['0000_base', '0001_seen']);
    // The migration saw no copy: none was taken of an empty database.
    expect(await withSql(fresh, async (sql) => [...(await sql`SELECT copies FROM seen`)])).toEqual([
      { copies: 0 },
    ]);

    const again = await migrateDatabase(fresh, options(program(M.base, M.seen), files));
    expect(again.snapshot).toBeNull();
    expect(again.applied).toEqual([]);
    expect(await listSnapshots(fresh, files.dir)).toEqual([]);
  }, 120_000);

  it('three migrations in a row: two copies kept, the oldest dropped only once the new one is complete', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const r1 = await migrateDatabase(url, options(program(M.base, M.seen), files));
    const r2 = await migrateDatabase(url, options(program(M.base, M.seen, M.destroy), files));
    expect(r2.pruned).toEqual([]);
    const r3 = await migrateDatabase(
      url,
      options(program(M.base, M.seen, M.destroy, M.more), files),
    );
    expect(r3.pruned).toEqual([r1.snapshot!.name]);
    expect((await listSnapshots(url, files.dir)).map((s) => s.name)).toEqual([
      r3.snapshot!.name,
      r2.snapshot!.name,
    ]);
    expect(existsSync(r1.snapshot!.stateDir)).toBe(false);

    // A fourth copy that cannot be made removes NOTHING: the two stay.
    await expect(
      migrateDatabase(
        url,
        options(program(M.base, M.seen, M.destroy, M.more, M.evenMore), files, {
          freeBytes: () => 0,
        }),
      ),
    ).rejects.toThrow(/SNAPSHOT_NO_SPACE/);
    expect((await listSnapshots(url, files.dir)).map((s) => s.name)).toEqual([
      r3.snapshot!.name,
      r2.snapshot!.name,
    ]);
    expect(await tableExists(url, 'even_more')).toBe(false);
  }, 180_000);

  it('the repair of a skipped migration goes through the copy too', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    await migrateDatabase(url, options(program(M.base, M.seen, M.destroy), files));
    // 0001 skipped, the way the migrator leaves it (#298).
    await withSql(url, async (sql) => {
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${M.seen.when}`;
      await sql`DROP TABLE seen`;
    });
    const gapped = program(M.base, M.seen, M.destroy);
    const refused = await migrateDatabase(url, options(gapped, files)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(MigrationGapError);
    expect((refused as MigrationGapError).gaps.map((g) => g.tag)).toEqual(['0001_seen']);

    // One copy so far: the one taken before 0002.
    expect(await listSnapshots(url, files.dir)).toHaveLength(1);
    const repaired = await migrateDatabase(url, options(gapped, files, { repair: true }));
    expect(repaired.repaired).toEqual(['0001_seen']);
    expect(repaired.snapshot).not.toBeNull();
    expect(await tableExists(urlOf(url, repaired.snapshot!.name), 'seen')).toBe(false);
    // The repaired migration counted the copies when it ran: the repair's own
    // copy was already there, beside the first one.
    const [row] = await withSql(url, async (sql) => [
      ...(await sql<{ copies: number }[]>`SELECT copies FROM seen`),
    ]);
    expect(row!.copies).toBe(2);
  }, 180_000);
});

describe('migrateDatabase: a program older than the database @cap:installer-et-demarrer/moteur', () => {
  it('refused before anything is written, the message names the version that migrated it', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    await migrateDatabase(
      url,
      options(program(M.base, M.seen, M.destroy), files, { programVersion: '0.9.12' }),
    );
    const historyBefore = await history(url);
    const rowsBefore = await notes(url);

    const older = program(M.base, M.seen);
    const err = await migrateDatabase(
      url,
      options(older, files, { programVersion: '0.9.11' }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DatabaseNewerThanProgramError);
    const e = err as DatabaseNewerThanProgramError;
    expect(e.unknown).toEqual([M.destroy.when]);
    expect(e.openedBy).toMatchObject({ version: '0.9.12', lastMigration: '0002_destroy' });
    expect(e.programLastMigration).toBe('0001_seen');
    expect(e.message).toContain('version 0.9.12');

    expect(await history(url)).toEqual(historyBefore);
    expect(await notes(url)).toEqual(rowsBefore);
    // The refusal did not overwrite who opened it.
    expect(await readOpenedBy(url)).toMatchObject({ version: '0.9.12' });
  }, 120_000);

  it('the same rule without a recorded version: still refused, the message says it is not known', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    await migrateDatabase(url, options(program(M.base, M.seen, M.destroy), files));
    await withSql(
      url,
      (sql) => sql`DELETE FROM app_settings WHERE key = ${SCHEMA_OPENED_BY_SETTING}`,
    );

    const err = await migrateDatabase(url, options(program(M.base, M.seen), files)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DatabaseNewerThanProgramError);
    expect((err as DatabaseNewerThanProgramError).openedBy).toBeNull();
    expect((err as Error).message).toContain('it did not record which');
  }, 120_000);

  it('an existing install that never recorded a version, and is not newer: starts, and records one', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    await withSql(
      url,
      (sql) => sql`DELETE FROM app_settings WHERE key = ${SCHEMA_OPENED_BY_SETTING}`,
    );
    expect(await readOpenedBy(url)).toBeNull();

    const result = await migrateDatabase(
      url,
      options(program(M.base), files, { programVersion: '0.9.11' }),
    );
    expect(result.snapshot).toBeNull();
    expect(await readOpenedBy(url)).toMatchObject({
      version: '0.9.11',
      lastMigration: '0000_base',
    });
  }, 120_000);
});

describe('snapshots: going back is refused when the keys do not match @cap:installer-et-demarrer/moteur', () => {
  it('a master key different from the one saved with the copy: nothing swapped', async () => {
    const files = stateFiles();
    const url = await installAtBase(files);
    const before = await notes(url);
    const result = await migrateDatabase(url, options(program(M.base, M.destroy), files));
    writeFileSync(files.keyPath, randomBytes(32).toString('base64'));

    await expect(
      restoreSnapshot(url, result.snapshot!.name, {
        at: tick(),
        madeBy: '9.9.9',
        stateFiles: files,
        currentLastMigration: '0002_destroy',
        currentOpenedBy: '9.9.9',
      }),
    ).rejects.toThrow(/SNAPSHOT_KEY_MISMATCH/);
    // Still the migrated database, the copy still a copy.
    expect(await notes(url)).toEqual([{ id: 1, body: 'first' }]);
    expect(await notes(urlOf(url, result.snapshot!.name))).toEqual(before);
  }, 120_000);
});

describe('the REAL journal, as `up` runs it without pgvector @cap:installer-et-demarrer/moteur', () => {
  it('a fresh database: every real migration applied, no copy; again: nothing pending, no copy', async () => {
    const files = stateFiles();
    const url = await freshDatabase();
    const journal = readProgramJournal({ patchVectorAsText: true });

    const first = await migrateDatabase(url, realOptions(files));
    expect(first.snapshot).toBeNull();
    expect(first.applied).toHaveLength(journal.length);
    expect(await readOpenedBy(url)).toMatchObject({ lastMigration: journal.at(-1)!.tag });

    const again = await migrateDatabase(url, realOptions(files));
    expect(again.applied).toEqual([]);
    expect(again.snapshot).toBeNull();
  }, 180_000);

  it('a copy of the real schema with rows, and back: the rows come back identical', async () => {
    const files = stateFiles();
    const url = await freshDatabase();
    await migrateDatabase(url, realOptions(files));
    const settings = async (u: string): Promise<unknown[]> =>
      withSql(u, async (sql) => [...(await sql`SELECT key, value FROM app_settings ORDER BY key`)]);
    await withSql(
      url,
      (sql) => sql`INSERT INTO app_settings (key, value) VALUES ('probe', 'before')`,
    );
    const before = await settings(url);

    const snap = await createSnapshot(url, {
      at: tick(),
      kind: 'before-migration',
      lastMigration: readProgramJournal().at(-1)!.tag,
      lastOpenedBy: null,
      madeBy: '9.9.9',
      stateFiles: files,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
    });
    await withSql(url, (sql) => sql`UPDATE app_settings SET value = 'after' WHERE key = 'probe'`);
    await restoreSnapshot(url, snap.name, {
      at: tick(),
      madeBy: '9.9.9',
      stateFiles: files,
      currentLastMigration: snap.meta!.lastMigration,
      currentOpenedBy: null,
    });
    expect(await settings(url)).toEqual(before);
  }, 180_000);
});
