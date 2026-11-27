// backup.pg.test.ts — an install saved to one file and brought back, on a
// REAL Postgres, with the REAL schema.
//
// Every case runs the real journal (vectors as text, as `up` migrates a
// cluster without pgvector), real `COPY` through the driver, real renames and
// real files in temporary homes. The round trip seeds EVERY table of the
// schema with one row, through a generic writer that puts the awkward value of
// each column type in it (text with newlines, tabs, backslashes, quotes and
// four-byte characters; jsonb; timestamps with zone on a DST edge; a bigint
// past 2^53; real and numeric; text and uuid arrays; a vector in its text
// notation), and the generated search columns are compared after the restore
// like every other column. Content is compared table by table, as the text of
// every row, not as counts.
//
// The journals of the "older" and "newer" cases are the real one plus one
// migration, built in a temporary folder.

import { afterAll, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { startOwnRealPostgres, startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { NODAL_CONFIG_FILE } from '@nodal-agents/shared/nodal-config-file';
import { MASTER_KEY_FILE, decrypt, encrypt, masterKeyCheckValue } from '@nodal-agents/secrets';
import { migrateDatabase, type MigrateDatabaseOptions } from '../safe-migrate.ts';
import { listSnapshots, restoreSnapshot, type SnapshotStateFiles } from '../snapshots.ts';
import {
  BackupError,
  createBackup,
  listBackups,
  restoreBackup,
  type BackupStep,
  type CreateBackupOptions,
  type RestoreBackupOptions,
} from '../backup.ts';
import {
  BackupReader,
  BackupWriter,
  readBackupHeader,
  type BackupRecordHeader,
} from '../backup-archive.ts';
import { gunzipSync } from 'node:zlib';
import { readProgramJournal } from '../migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REAL_MIGRATIONS = join(here, '..', '..', 'migrations');
const scratch = mkdtempSync(join(tmpdir(), 'nodal-backup-pg-'));

// ─── Homes ───────────────────────────────────────────────────────────────────

interface Home extends SnapshotStateFiles {
  readonly root: string;
  readonly configPath: string;
  readonly keyPath: string;
  readonly key: Buffer;
}

/** A home's state files (a config and a master key of the right shapes), in a folder with a space and an accent. */
function newHome(): Home {
  const root = join(scratch, `home é ${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  const configPath = join(root, 'config.json');
  const keyPath = join(root, 'secrets.key');
  const key = randomBytes(32);
  writeFileSync(
    configPath,
    JSON.stringify({
      ports: { web: 3000, runner: 3001, postgres: 25432 },
      workerSecret: randomBytes(24).toString('hex'),
      postgresPassword: randomBytes(18).toString('base64url'),
    }),
  );
  writeFileSync(keyPath, key.toString('base64'));
  return {
    root,
    configPath,
    keyPath,
    key,
    dir: join(root, 'snapshots'),
    files: [
      { name: 'config.json', path: configPath, spec: NODAL_CONFIG_FILE, boundToDatabase: false },
      { name: 'secrets.key', path: keyPath, spec: MASTER_KEY_FILE, boundToDatabase: true },
    ],
  };
}

// ─── Databases ───────────────────────────────────────────────────────────────

const opened: RealPostgres[] = [];

afterAll(async () => {
  for (const pg of opened) {
    for (const s of await listSnapshots(pg.url, scratch).catch(() => [])) {
      await withSql(urlOf(pg.url, 'postgres'), (sql) =>
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

async function withSql<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

let clock = Date.UTC(2026, 10, 28, 9, 0, 0);
function tick(): Date {
  clock += 1_000;
  return new Date(clock);
}

function migrateOptions(
  home: SnapshotStateFiles,
  over: Partial<MigrateDatabaseOptions> = {},
): MigrateDatabaseOptions {
  return {
    patchVectorAsText: true,
    repair: false,
    programVersion: '9.9.9',
    keep: 2,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stateFiles: home,
    now: tick,
    ...over,
  };
}

function backupOptions(home: Home, over: Partial<CreateBackupOptions> = {}): CreateBackupOptions {
  return {
    dir: join(home.root, 'backups'),
    stateFiles: home,
    programVersion: '9.9.9',
    now: tick,
    ...over,
  };
}

function restoreOptions(
  home: Home,
  archive: string,
  over: Partial<RestoreBackupOptions> = {},
): RestoreBackupOptions {
  return {
    archive,
    vector: false,
    stateFiles: home,
    programVersion: '9.9.9',
    keep: 2,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    now: tick,
    ...over,
  };
}

/** A migrated install: the real schema, a stored credential encrypted with the home's key. */
async function install(home: Home, over: Partial<MigrateDatabaseOptions> = {}): Promise<string> {
  const url = await freshDatabase();
  await migrateDatabase(url, migrateOptions(home, over));
  await withSql(url, async (sql) => {
    await sql`INSERT INTO app_settings (key, value) VALUES ('master_key_check', ${masterKeyCheckValue(home.key)})`;
    await sql`INSERT INTO app_settings (key, value) VALUES ('probe', ${`installed ${home.root}`})`;
  });
  await seedEveryTable(
    url,
    { credentials: { payload: encrypt('{"refresh_token":"r-1"}', home.key) } },
    ['credentials'],
  );
  return url;
}

// ─── Every table, one row, the awkward value of each type ────────────────────

const AWKWARD_TEXT =
  'ligne une\nligne deux\ttabulée \\ antislash \r retour "guillemets" \'apostrophe\' é 漢字 🙂 \\N fin';

function valueFor(type: string): string | null {
  if (type === 'uuid') return randomUUID();
  if (type === 'text' || type.startsWith('character varying')) return AWKWARD_TEXT;
  if (type === 'timestamp with time zone') return '2026-03-29T01:30:00.123456+01:00';
  if (type === 'timestamp without time zone') return '2026-03-29 02:30:00.5';
  if (type === 'date') return '2026-02-28';
  if (type === 'integer') return '2147483647';
  if (type === 'smallint') return '32767';
  if (type === 'bigint') return '9007199254740993';
  if (type === 'boolean') return 'true';
  if (type === 'real') return '0.1';
  if (type === 'double precision') return '0.30000000000000004';
  if (type.startsWith('numeric')) return '1234.567891';
  if (type === 'jsonb' || type === 'json') {
    return JSON.stringify({
      a: [1, 2.5, 'é\n\t\\'],
      b: null,
      c: { d: true },
      big: 12345678901234567890,
    });
  }
  if (type === 'text[]') return '{"a","b,c","d\\"e",NULL,"ligne\\nx"}';
  if (type === 'uuid[]') return `{${randomUUID()},${randomUUID()}}`;
  throw new Error(`no awkward value for type ${type}: add one`);
}

/** Values a CHECK constraint shapes beyond what the seeder reads from its definition (a pattern, a rule across columns). */
const SHAPED: Record<string, Record<string, string | null>> = {
  conversation_handles: { id: 'conv_abcdefgh23' },
  tool_call_reads: { sha256: 'a'.repeat(64) },
  device_pairings: {
    user_code: '123456',
    name: 'Salon',
    capabilities: '{microphone,speaker}',
    status: 'pending',
  },
  job_deliverable_verification_state: {
    deliverable_type: 'code_project',
    outcome: null,
    dirty_generation: '2',
    verified_generation: '1',
  },
};

interface SeedColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly sequenced: boolean;
}

/** A smaller value of the same type, where the type has one. */
function smallFor(type: string): string | undefined {
  if (type.endsWith('[]')) return '{}';
  if (/int|numeric|real|double/.test(type)) return '1';
  if (type === 'boolean') return 'false';
  if (type === 'jsonb') return '[]';
  if (type === 'text') return 'a';
  return undefined;
}

/** A constraint that is a list of allowed values for one column: that column and the list. */
const ALLOWED_LIST = /^CHECK \(\(\(?(\w+) = ANY \(ARRAY\[([^\]]*)\]/;

/**
 * One row in every table of `public`, foreign keys off (the rows reference
 * nothing real), the CHECK constraints satisfied by reading their definitions:
 * a column limited to a list gets its first value; a column another
 * constraint still refuses is set to NULL when it may, else to a smaller
 * value of its type. `SHAPED` holds the few a definition does not spell out.
 */
async function seedEveryTable(
  url: string,
  overrides: Record<string, Record<string, string>>,
  only?: readonly string[],
): Promise<string[]> {
  return withSql(url, async (sql) => {
    const tables = (
      await sql<{ table: string }[]>`
        SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY 1`
    )
      .map((r) => r.table)
      .filter((t) => only === undefined || only.includes(t));
    const seeded: string[] = [];
    for (const table of tables) {
      const columns = await sql<SeedColumn[]>`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
               NOT a.attnotnull AS nullable,
               (a.attidentity <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%') AS sequenced
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ${`public.${table}`}::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attgenerated = ''
        ORDER BY a.attnum`;
      const checks = await sql<{ name: string; def: string }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = ${`public.${table}`}::regclass AND contype = 'c'`;
      const given = (c: string): string | null | undefined => {
        const o = overrides[table]?.[c];
        return o !== undefined ? o : SHAPED[table]?.[c];
      };
      const values = new Map<string, string | null>();
      const fixed = new Set<string>();
      for (const c of columns) {
        if (c.sequenced) continue;
        const v = given(c.name);
        if (v !== undefined) fixed.add(c.name);
        values.set(c.name, v !== undefined ? v : valueFor(c.type));
      }
      const lists = new Map<string, string[]>();
      for (const check of checks) {
        const whole = ALLOWED_LIST.exec(check.def);
        const column = whole?.[1];
        if (whole && column !== undefined && values.has(column) && !fixed.has(column)) {
          const allowed = [...whole[2]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
          values.set(column, allowed[0]!);
          lists.set(column, allowed.slice(1));
          fixed.add(column);
        }
      }
      const typeOf = new Map(columns.map((c) => [c.name, c.type]));
      for (let attempt = 0; ; attempt++) {
        const names = [...values.keys()];
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe('SET LOCAL session_replication_role = replica');
            await tx.unsafe(
              `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names
                .map((n, i) => `$${i + 1}::${typeOf.get(n)}`)
                .join(', ')})`,
              names.map((n) => values.get(n) ?? null),
            );
          });
          seeded.push(table);
          break;
        } catch (err) {
          const e = err as { code?: string; constraint_name?: string };
          if (e.code !== '23514' || attempt > 30) throw err;
          const def = checks.find((c) => c.name === e.constraint_name)?.def ?? '';
          const mentions = (name: string): boolean => def.split(/[^A-Za-z0-9_]+/).includes(name);
          const involved = columns.filter((c) => values.has(c.name) && mentions(c.name));
          const toNull = involved.find(
            (c) => c.nullable && values.get(c.name) !== null && given(c.name) === undefined,
          );
          const toShrink = involved.find((c) => {
            const v = smallFor(c.type);
            return !fixed.has(c.name) && v !== undefined && values.get(c.name) !== v;
          });
          const toNext = involved.find((c) => (lists.get(c.name)?.length ?? 0) > 0);
          if (toNull !== undefined) values.set(toNull.name, null);
          else if (toNext !== undefined) values.set(toNext.name, lists.get(toNext.name)!.shift()!);
          else if (toShrink !== undefined) values.set(toShrink.name, smallFor(toShrink.type)!);
          else throw err;
        }
      }
    }
    return seeded;
  });
}

/** Every row of every table, as text, in a stable order; the record of who opened it aside. */
async function contentOf(url: string): Promise<Map<string, string>> {
  return withSql(url, async (sql) => {
    await sql`SET TimeZone = 'UTC'`;
    await sql`SET extra_float_digits = 3`;
    const tables = await sql<{ schema: string; table: string }[]>`
      SELECT n.nspname AS schema, c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname IN ('public', 'drizzle') ORDER BY 1, 2`;
    const out = new Map<string, string>();
    for (const t of tables) {
      const where = t.table === 'app_settings' ? ` WHERE key <> 'schema_opened_by'` : '';
      const rows = await sql.unsafe<{ r: string }[]>(
        `SELECT t::text AS r FROM ONLY "${t.schema}"."${t.table}" t${where} ORDER BY 1`,
      );
      out.set(`${t.schema}.${t.table}`, rows.map((r) => r.r).join('\n'));
    }
    return out;
  });
}

async function sequencePositions(url: string): Promise<Map<string, string>> {
  return withSql(url, async (sql) => {
    const seqs = await sql<{ name: string }[]>`
      SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' ORDER BY 1`;
    const out = new Map<string, string>();
    for (const s of seqs) {
      const [row] = await sql.unsafe<{ v: string }[]>(
        `SELECT last_value::text AS v FROM ${s.name}`,
      );
      out.set(s.name, row!.v);
    }
    return out;
  });
}

async function credentialPayload(url: string): Promise<string> {
  return withSql(url, async (sql) => {
    const [row] = await sql<
      { payload: string }[]
    >`SELECT payload FROM credentials WHERE payload LIKE 'enc:%' LIMIT 1`;
    return row!.payload;
  });
}

async function probe(url: string): Promise<string | undefined> {
  return withSql(url, async (sql) => {
    const [row] = await sql<
      { value: string }[]
    >`SELECT value FROM app_settings WHERE key = 'probe'`;
    return row?.value;
  });
}

// ─── Archives rewritten by hand (what a damaged or foreign file looks like) ──

async function rewriteArchive(
  src: string,
  dst: string,
  change: (
    h: BackupRecordHeader,
    payload: Buffer,
  ) => { header: BackupRecordHeader; payload: Buffer } | null,
  opts: { passphrase?: string } = {},
): Promise<void> {
  const reader = await BackupReader.open(src, opts);
  const writer = await BackupWriter.create(dst, opts);
  try {
    for (;;) {
      const h = await reader.next();
      if (h === null) break;
      const { bytes } = await reader.payloadBytes();
      const out = change(h, bytes);
      if (out !== null) await writer.record(out.header, out.payload);
    }
    await writer.finish();
  } finally {
    reader.close();
  }
}

/** The real journal plus one migration after it. */
function realProgramPlus(sql: string): string {
  const folder = join(scratch, `program-${randomBytes(4).toString('hex')}`);
  cpSync(REAL_MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[];
  };
  const last = journal.entries.at(-1)!;
  const tag = '9999_backup_test_extra';
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 60_000,
    tag,
    breakpoints: true,
  });
  writeFileSync(join(folder, `${tag}.sql`), sql);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

async function rejection(p: Promise<unknown>): Promise<BackupError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BackupError);
  return err as BackupError;
}

// ─── The cases ───────────────────────────────────────────────────────────────

describe('backup and restore: the round trip @cap:installer-et-demarrer/moteur', () => {
  it('every table seeded, backed up, restored over a NEW install: identical table by table, sequences continue, the credential decrypts, the replaced install comes back', async () => {
    const source = newHome();
    const url = await install(source);
    // Every table but `credentials`, which the install already holds a row of.
    const others = await withSql(url, async (sql) =>
      (
        await sql<
          { t: string }[]
        >`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'credentials'`
      ).map((r) => r.t),
    );
    const seeded = await seedEveryTable(
      url,
      {
        agent_memory: { embedding: '[0.1,0.25,-3e-05]' },
        entity_llm_keys: { api_key: encrypt('sk-test-llm', source.key) },
      },
      others,
    );
    const publicTables = await withSql(
      url,
      async (sql) =>
        (
          await sql<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
        )[0]!.n,
    );
    expect(seeded).toHaveLength(publicTables - 1);
    const before = await contentOf(url);
    const seqBefore = await sequencePositions(url);
    const payload = await credentialPayload(url);

    const made = await createBackup(url, backupOptions(source));
    expect(made.tables.map((t) => `${t.schema}.${t.table}`).sort()).toEqual(
      [...before.keys()].sort(),
    );
    expect(made.tables.filter((t) => t.schema === 'public').every((t) => t.rows >= 1)).toBe(true);
    expect(made.keyProof).toBe('a stored OAuth credential');
    expect(made.stateFiles).toEqual(['config.json', 'secrets.key']);
    expect(listBackups(join(source.root, 'backups')).map((b) => b.path)).toEqual([made.path]);

    // A new install on this machine: its own schema, its own key, its own row.
    const target = newHome();
    const targetUrl = await install(target);
    const targetBefore = await contentOf(targetUrl);
    const targetKeyBytes = readFileSync(target.keyPath, 'utf-8');

    const back = await restoreBackup(targetUrl, restoreOptions(target, made.path));
    expect(back.proof).toBe('a stored OAuth credential');
    expect(back.migrated.applied).toEqual([]);

    const after = await contentOf(targetUrl);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [table, rows] of before)
      expect({ table, rows: after.get(table) }).toEqual({ table, rows });

    // The key is the archive's, and the credential opens with it.
    expect(readFileSync(target.keyPath, 'utf-8')).toBe(readFileSync(source.keyPath, 'utf-8'));
    const liveKey = MASTER_KEY_FILE.parse(readFileSync(target.keyPath, 'utf-8'));
    expect(decrypt(await credentialPayload(targetUrl), liveKey)).toBe('{"refresh_token":"r-1"}');
    expect(await credentialPayload(targetUrl)).toBe(payload);

    // Every sequence continues past where it was.
    expect(await sequencePositions(targetUrl)).toEqual(seqBefore);
    await withSql(targetUrl, async (sql) => {
      for (const [name, last] of seqBefore) {
        const [row] = await sql.unsafe<{ v: string }[]>(`SELECT nextval('${name}')::text AS v`);
        expect(BigInt(row!.v)).toBeGreaterThan(BigInt(last));
      }
    });

    // What it replaced is a copy, with its own key beside it, and comes back.
    expect(back.replaced.meta).toMatchObject({ kind: 'replaced-by-restore' });
    expect(readFileSync(join(back.replaced.stateDir, 'secrets.key'), 'utf-8')).toBe(targetKeyBytes);
    expect(back.putBack).toEqual([{ path: target.keyPath, previous: 'replaced' }]);
    await restoreSnapshot(targetUrl, back.replaced.name, {
      at: tick(),
      madeBy: '9.9.9',
      stateFiles: target,
      currentLastMigration: readProgramJournal().at(-1)!.tag,
      currentOpenedBy: '9.9.9',
    });
    const reverted = await contentOf(targetUrl);
    for (const [table, rows] of targetBefore)
      expect({ table, rows: reverted.get(table) }).toEqual({ table, rows });
    expect(readFileSync(target.keyPath, 'utf-8')).toBe(targetKeyBytes);
  }, 300_000);

  it('into a fresh, empty cluster on another data folder (the path to a new major version): identical', async () => {
    const source = newHome();
    const url = await install(source);
    const others = await withSql(url, async (sql) =>
      (
        await sql<
          { t: string }[]
        >`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'credentials'`
      ).map((r) => r.t),
    );
    await seedEveryTable(url, {}, others);
    const before = await contentOf(url);
    const made = await createBackup(url, backupOptions(source));

    const other = await startOwnRealPostgres();
    opened.push(other);
    expect(other.dataDir).not.toBe(opened[0]!.dataDir);
    const target = newHome();
    // Nothing was ever migrated there, and no key exists yet.
    const { rmSync } = await import('node:fs');
    rmSync(target.keyPath);
    const back = await restoreBackup(other.url, restoreOptions(target, made.path));
    expect(back.putBack).toEqual([{ path: target.keyPath, previous: 'missing' }]);
    const after = await contentOf(other.url);
    for (const [table, rows] of before)
      expect({ table, rows: after.get(table) }).toEqual({ table, rows });
  }, 300_000);

  it('with a passphrase and the workspaces: the same rows, the workspace bytes identical, nothing readable without it', async () => {
    const source = newHome();
    const url = await install(source);
    const ws = join(source.root, 'workspaces');
    mkdirSync(join(ws, 'entité', 'shared', 'vide'), { recursive: true });
    writeFileSync(join(ws, 'entité', 'shared', 'notes é.md'), '# Titre\r\nligne\n');
    writeFileSync(join(ws, 'entité', 'shared', 'empty.txt'), '');
    const binary = randomBytes(300_000);
    writeFileSync(join(ws, 'entité', 'blob.bin'), binary);
    const before = await contentOf(url);

    const made = await createBackup(
      url,
      backupOptions(source, { passphrase: 'cœur ünïcode', workspacesDir: ws }),
    );
    expect(made.encrypted).toBe(true);
    expect(made.workspaces).toMatchObject({ files: 3, dirs: 3, skipped: [] });
    // The body is ciphertext: it does not even decompress.
    const { bodyStart } = readBackupHeader(made.path);
    expect(() => gunzipSync(readFileSync(made.path).subarray(bodyStart))).toThrow();

    const target = newHome();
    const targetUrl = await install(target);
    const noPass = await rejection(restoreBackup(targetUrl, restoreOptions(target, made.path)));
    expect(noPass.code).toBe('BACKUP_PASSPHRASE_REQUIRED');
    const wrong = await rejection(
      restoreBackup(targetUrl, restoreOptions(target, made.path, { passphrase: 'coeur unicode' })),
    );
    expect(wrong.code).toBe('BACKUP_WRONG_PASSPHRASE');
    expect(await probe(targetUrl)).toBe(`installed ${target.root}`);

    const into = join(target.root, 'workspaces.restoring');
    // The same passphrase typed in its decomposed form (macOS input) opens it.
    await restoreBackup(
      targetUrl,
      restoreOptions(target, made.path, {
        passphrase: 'cœur ünïcode'.normalize('NFD'),
        workspacesInto: into,
      }),
    );
    const after = await contentOf(targetUrl);
    for (const [table, rows] of before)
      expect({ table, rows: after.get(table) }).toEqual({ table, rows });
    expect(readFileSync(join(into, 'entité', 'shared', 'notes é.md'), 'utf-8')).toBe(
      '# Titre\r\nligne\n',
    );
    expect(readFileSync(join(into, 'entité', 'shared', 'empty.txt'), 'utf-8')).toBe('');
    expect(readFileSync(join(into, 'entité', 'blob.bin')).equals(binary)).toBe(true);
    expect(existsSync(join(into, 'entité', 'shared', 'vide'))).toBe(true);
  }, 300_000);
});

describe('backup: nothing that looks complete unless it is @cap:installer-et-demarrer/moteur', () => {
  const steps: BackupStep[] = [
    'started',
    'manifest',
    'state-files',
    'table',
    'sequences',
    'workspaces',
    'written',
    'verified',
  ];

  it('interrupted at each step: no file with a backup name, no temporary file left', async () => {
    const home = newHome();
    const url = await install(home);
    const ws = join(home.root, 'workspaces');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'a.txt'), 'a');
    const dir = join(home.root, 'backups');
    for (const step of steps) {
      const err = await rejection(
        createBackup(
          url,
          backupOptions(home, {
            workspacesDir: ws,
            seams: {
              at: (s) => {
                if (s === step) throw new Error(`stopped at ${step}`);
              },
            },
          }),
        ),
      );
      expect(err.message).toContain(`stopped at ${step}`);
      expect(listBackups(dir)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    }
    // And without the seam, the same call publishes one.
    const made = await createBackup(url, backupOptions(home, { workspacesDir: ws }));
    expect(readdirSync(dir)).toEqual([made.path.split(/[\\/]/).at(-1)]);
  }, 300_000);

  it('a read-back that differs: a flipped byte, or a well-formed file with one row changed: refused, nothing published', async () => {
    const home = newHome();
    const url = await install(home);
    const dir = join(home.root, 'backups');

    const flipped = await rejection(
      createBackup(
        url,
        backupOptions(home, {
          seams: {
            beforeVerify: (temp) => {
              const bytes = readFileSync(temp);
              bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 0xff;
              writeFileSync(temp, bytes);
            },
          },
        }),
      ),
    );
    expect(flipped.code).toBe('BACKUP_VERIFY_FAILED');
    expect(readdirSync(dir)).toEqual([]);

    const changed = await rejection(
      createBackup(
        url,
        backupOptions(home, {
          seams: {
            beforeVerify: async (temp) => {
              const copy = `${temp}.copy`;
              await rewriteArchive(temp, copy, (h, payload) =>
                h.kind === 'table' && h.table === 'app_settings'
                  ? {
                      header: h,
                      payload: Buffer.from(
                        payload.toString('utf-8').replace('installed', 'INSTALLED'),
                      ),
                    }
                  : { header: h, payload },
              );
              const { renameSync } = await import('node:fs');
              renameSync(copy, temp);
            },
          },
        }),
      ),
    );
    expect(changed.code).toBe('BACKUP_VERIFY_FAILED');
    expect(changed.message).toContain('table public.app_settings differs from the database');
    expect(readdirSync(dir)).toEqual([]);
  }, 300_000);

  it('--keep 2 after three backups: the two newest stay, the oldest goes only after the third is published', async () => {
    const home = newHome();
    const url = await install(home);
    const dir = join(home.root, 'backups');
    const a = await createBackup(url, backupOptions(home, { keep: 2 }));
    const b = await createBackup(url, backupOptions(home, { keep: 2 }));
    expect(listBackups(dir).map((f) => f.path)).toEqual([b.path, a.path]);
    // A third that fails removes nothing.
    await rejection(
      createBackup(
        url,
        backupOptions(home, {
          keep: 2,
          seams: {
            at: (s) => {
              if (s === 'verified') throw new Error('no');
            },
          },
        }),
      ),
    );
    expect(listBackups(dir).map((f) => f.path)).toEqual([b.path, a.path]);
    const c = await createBackup(url, backupOptions(home, { keep: 2 }));
    expect(c.pruned).toEqual([a.path.split(/[\\/]/).at(-1)]);
    expect(listBackups(dir).map((f) => f.path)).toEqual([c.path, b.path]);
    // A file that is not a backup is never touched.
    writeFileSync(join(dir, 'mes notes.txt'), 'x');
    await createBackup(url, backupOptions(home, { keep: 1 }));
    expect(existsSync(join(dir, 'mes notes.txt'))).toBe(true);
  }, 300_000);

  it('a master key that does not open the database, or none: no backup is made', async () => {
    const home = newHome();
    const url = await install(home);
    const dir = join(home.root, 'backups');
    writeFileSync(home.keyPath, randomBytes(32).toString('base64'));
    const wrong = await rejection(createBackup(url, backupOptions(home)));
    expect(wrong.code).toBe('BACKUP_KEY_DOES_NOT_OPEN');
    const { rmSync } = await import('node:fs');
    rmSync(home.keyPath);
    const missing = await rejection(createBackup(url, backupOptions(home)));
    expect(missing.code).toBe('BACKUP_KEY_MISSING');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  }, 300_000);
});

describe('restore: refused before anything is replaced @cap:installer-et-demarrer/moteur', () => {
  it('an archive from an OLDER schema is restored, then migrated by the normal path, with the copy before it', async () => {
    const source = newHome();
    const url = await install(source);
    const made = await createBackup(url, backupOptions(source));

    const newer = realProgramPlus('CREATE TABLE backup_test_extra (id integer);');
    const target = newHome();
    const targetUrl = await install(target, { migrationsFolder: newer });
    const back = await restoreBackup(
      targetUrl,
      restoreOptions(target, made.path, { migrationsFolder: newer }),
    );
    expect(back.migrated.applied).toEqual(['9999_backup_test_extra']);
    expect(back.migrated.snapshot?.meta?.kind).toBe('before-migration');
    expect(await probe(targetUrl)).toBe(`installed ${source.root}`);
    const [row] = await withSql(
      targetUrl,
      (sql) => sql`SELECT to_regclass('public.backup_test_extra') IS NOT NULL AS ok`,
    );
    expect(row!.ok).toBe(true);
  }, 300_000);

  it('an archive from a NEWER schema: refused, the message names both versions, nothing changed', async () => {
    const newer = realProgramPlus('CREATE TABLE backup_test_extra (id integer);');
    const source = newHome();
    const url = await install(source, { migrationsFolder: newer, programVersion: '1.2.3' });
    const made = await createBackup(
      url,
      backupOptions(source, { migrationsFolder: newer, programVersion: '1.2.3' }),
    );

    const target = newHome();
    const targetUrl = await install(target);
    const keyBefore = readFileSync(target.keyPath, 'utf-8');
    const err = await rejection(
      restoreBackup(targetUrl, restoreOptions(target, made.path, { programVersion: '1.2.2' })),
    );
    expect(err.code).toBe('BACKUP_NEWER_THAN_PROGRAM');
    expect(err.message).toContain('made by version 1.2.3');
    expect(err.message).toContain('this program (1.2.2)');
    expect(err.message).toContain('9999_backup_test_extra');
    expect(await probe(targetUrl)).toBe(`installed ${target.root}`);
    expect(await listSnapshots(targetUrl, target.dir)).toEqual([]);
    expect(readFileSync(target.keyPath, 'utf-8')).toBe(keyBefore);
  }, 300_000);

  it('an archive with a wrong key, or with none: refused, the copy it filled dropped, the live database and key untouched', async () => {
    const source = newHome();
    const url = await install(source);
    const made = await createBackup(url, backupOptions(source));
    const wrongKey = join(scratch, `wrong-${randomBytes(3).toString('hex')}.nodalbak`);
    await rewriteArchive(made.path, wrongKey, (h, payload) =>
      h.kind === 'state-file' && h.name === 'secrets.key'
        ? { header: h, payload: Buffer.from(randomBytes(32).toString('base64')) }
        : { header: h, payload },
    );
    const noKey = join(scratch, `nokey-${randomBytes(3).toString('hex')}.nodalbak`);
    await rewriteArchive(made.path, noKey, (h, payload) =>
      h.kind === 'state-file' && h.name === 'secrets.key' ? null : { header: h, payload },
    );

    const target = newHome();
    const targetUrl = await install(target);
    const keyBefore = readFileSync(target.keyPath, 'utf-8');
    const wrong = await rejection(restoreBackup(targetUrl, restoreOptions(target, wrongKey)));
    expect(wrong.code).toBe('BACKUP_KEY_DOES_NOT_OPEN');
    const missing = await rejection(restoreBackup(targetUrl, restoreOptions(target, noKey)));
    expect(missing.code).toBe('BACKUP_KEY_MISSING');
    expect(await probe(targetUrl)).toBe(`installed ${target.root}`);
    expect(readFileSync(target.keyPath, 'utf-8')).toBe(keyBefore);
    expect(await listSnapshots(targetUrl, target.dir)).toEqual([]);
    expect(existsSync(target.dir) ? readdirSync(target.dir) : []).toEqual([]);
  }, 300_000);

  it('an archive whose rows do not match its own checks, or that writes outside its folder: refused', async () => {
    const source = newHome();
    const url = await install(source);
    const ws = join(source.root, 'workspaces');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'a.txt'), 'a');
    const made = await createBackup(url, backupOptions(source, { workspacesDir: ws }));
    const escaping = join(scratch, `escape-${randomBytes(3).toString('hex')}.nodalbak`);
    await rewriteArchive(made.path, escaping, (h, payload) =>
      h.kind === 'workspace-file'
        ? { header: { ...h, path: '../outside.txt' }, payload }
        : { header: h, payload },
    );
    const truncated = join(scratch, `cut-${randomBytes(3).toString('hex')}.nodalbak`);
    const full = readFileSync(made.path);
    writeFileSync(truncated, full.subarray(0, Math.floor(full.length * 0.8)));

    const target = newHome();
    const targetUrl = await install(target);
    const into = join(target.root, 'ws-in');
    const out = await rejection(
      restoreBackup(targetUrl, restoreOptions(target, escaping, { workspacesInto: into })),
    );
    expect(out.code).toBe('BACKUP_DAMAGED');
    expect(existsSync(join(target.root, 'outside.txt'))).toBe(false);
    expect(existsSync(into)).toBe(false);
    const cut = await rejection(restoreBackup(targetUrl, restoreOptions(target, truncated)));
    expect(cut.code).toBe('BACKUP_DAMAGED');
    expect(await probe(targetUrl)).toBe(`installed ${target.root}`);
    expect(await listSnapshots(targetUrl, target.dir)).toEqual([]);
  }, 300_000);
});
