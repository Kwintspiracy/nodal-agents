// snapshots.ts — copies of the database INSIDE its own cluster, with the state
// files that belong with them, and the way back to one.
//
// THE ONE MODULE that copies, lists, prunes and swaps back a snapshot. The
// migration path (`safe-migrate.ts`) and the `rollback` command both go
// through it, and so will a portable backup.
//
// HOW A COPY IS MADE. `CREATE DATABASE <copy> TEMPLATE <database>`, the copy
// PostgreSQL makes itself (manual, CREATE DATABASE). It needs no dump tool,
// which the embedded cluster does not ship. Its condition is the manual's: no
// other session may be connected to the source while it is copied, and the
// statement fails if one is when it starts (SQLSTATE 55006). At the point a
// start migrates, nothing else is connected, so the condition holds; when it
// does not, the copy is refused and so is the migration (invariant #4). The
// manual also says what the copy does NOT carry: database-level settings
// (`ALTER DATABASE … SET`) and privileges (`GRANT … ON DATABASE`), which no
// migration of this repository sets, and the comment on the database, which
// is how a copy is labelled here.
//
// WHAT A COPY IS CALLED. `<database>_snap_<UTC yyyymmddhhmmssSSS>_<number of the
// newest migration applied>`, so the name alone says when it was taken and how
// far its schema went. The full description is a JSON comment on the copy
// (`COMMENT ON DATABASE`): what it is a copy of, why it was taken, the newest
// migration, the version that last opened it, the version that took it, and
// the state files saved beside it. The comment is written LAST: a copy without
// one was cut before it was complete, and is listed as such.
//
// THE STATE FILES THAT GO WITH IT. A database is only usable with the master
// key its secrets were encrypted with and the config that holds the cluster's
// password. Both are copied beside every snapshot, into
// `<home>/snapshots/<copy name>/`, through `createStateFile` (exclusive,
// flushed, owner-only). That folder is a child of the Nodal home, refused to a
// sandboxed command like `secrets.key` itself (packages/sandbox/src/policy.ts).
//
// GOING BACK is a swap, not a copy: in one transaction the current database is
// renamed to a snapshot name of its own (kept, never dropped, described as
// replaced by a rollback or a restore, its state files saved the same way) and
// the chosen snapshot takes the database's name. `config.json` is NOT put
// back: the password and the ports in it are the cluster's, which a database
// copy does not carry, and an older copy of them could lock the install out.
// The master key travels WITH its database, both ways: the live key is saved
// beside the replaced database first, then the key saved with the chosen copy
// becomes the live one. Each database keeps the key it was encrypted with,
// and either can be swapped back in later the same way.
//
// A RESTORE FROM A BACKUP (backup.ts) goes through the same swap: it loads the
// archive into an EMPTY copy (`createEmptySnapshot`), which stays incomplete
// (no description) until it is loaded, counted and its key proved, and is
// then described like any copy (`completeSnapshot`, kind `from-backup`, the
// archive's state files beside it). The database it replaces is kept.

import postgres from 'postgres';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  createStateFile,
  replaceStateFile,
  masterKeyFilePath,
  nodalConfigPath,
  type StateFileSpec,
} from '@nodal-agents/shared/state-files';
import { NODAL_CONFIG_FILE } from '@nodal-agents/shared/nodal-config-file';
import { nodalHomePath } from '@nodal-agents/shared/nodal-home';
import { MASTER_KEY_FILE } from '@nodal-agents/secrets';

/** How many snapshots are kept when `config.json` says nothing (`snapshots.keep`). */
export { DEFAULT_SNAPSHOTS_KEPT } from '@nodal-agents/shared/nodal-config';

/** Why a copy exists. */
export type SnapshotKind =
  | 'before-migration'
  | 'replaced-by-rollback'
  | 'from-backup'
  | 'replaced-by-restore';

const SNAPSHOT_KINDS: readonly SnapshotKind[] = [
  'before-migration',
  'replaced-by-rollback',
  'from-backup',
  'replaced-by-restore',
];

/** The JSON comment that describes a complete copy. */
export interface SnapshotMeta {
  readonly nodalSnapshot: 1;
  /** The database it is a copy of. */
  readonly of: string;
  readonly kind: SnapshotKind;
  /** ISO time the copy was taken. */
  readonly at: string;
  /** Tag of the newest migration the copy holds, when known. */
  readonly lastMigration: string | null;
  /** The version that last opened the database before the copy, when recorded. */
  readonly lastOpenedBy: string | null;
  /** The version that took the copy. */
  readonly madeBy: string;
  /** The state files saved beside it (file names in its folder). */
  readonly stateFiles: readonly string[];
}

export interface Snapshot {
  readonly name: string;
  readonly sizeBytes: number;
  /** `null`: the copy exists but was never completed (no description). */
  readonly meta: SnapshotMeta | null;
  /** Where its state files are. */
  readonly stateDir: string;
}

/** One state file saved with every snapshot. */
export interface SnapshotStateFile {
  /** Its name in the snapshot's folder. */
  readonly name: string;
  /** Where the live one is. */
  readonly path: string;
  readonly spec: StateFileSpec<unknown>;
  /**
   * The database depends on this file (the master key its secrets are
   * encrypted with). It travels with its database: going back to a copy makes
   * the file saved with it the live one, the live one being saved beside the
   * database it replaces first. A file without this flag (the config: its
   * password and ports are the cluster's) is never put back.
   */
  readonly boundToDatabase: boolean;
}

/** The state files of an install, and where their copies go. */
export interface SnapshotStateFiles {
  /** The folder holding one sub-folder per snapshot. */
  readonly dir: string;
  readonly files: readonly SnapshotStateFile[];
}

/** The state files of THIS home: the config and the master key. */
export function homeStateFiles(): SnapshotStateFiles {
  return {
    dir: nodalHomePath('snapshots'),
    files: [
      {
        name: basename(nodalConfigPath()),
        path: nodalConfigPath(),
        spec: NODAL_CONFIG_FILE,
        boundToDatabase: false,
      },
      {
        name: basename(masterKeyFilePath()),
        path: masterKeyFilePath(),
        spec: MASTER_KEY_FILE,
        boundToDatabase: true,
      },
    ],
  };
}

export type SnapshotErrorCode =
  | 'SNAPSHOT_SOURCE_IN_USE'
  | 'SNAPSHOT_NO_SPACE'
  | 'SNAPSHOT_NOT_PERMITTED'
  | 'SNAPSHOT_FAILED'
  | 'SNAPSHOT_NOT_FOUND';

/** A copy could not be made, found or put back. The message says why, with the numbers. */
export class SnapshotError extends Error {
  constructor(
    readonly code: SnapshotErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SnapshotError';
  }
}

// ─── Names and sizes ─────────────────────────────────────────────────────────

const MAX_IDENTIFIER_BYTES = 63;

function stamp(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}` +
    p(at.getUTCMilliseconds(), 3)
  );
}

/** The name of a copy of `database` taken at `at`, whose newest migration is `lastMigration`. */
export function snapshotName(database: string, at: Date, lastMigration: string | null): string {
  const number = /^(\d+)_/.exec(lastMigration ?? '')?.[1] ?? 'none';
  const name = `${database}_snap_${stamp(at)}_${number}`;
  if (Buffer.byteLength(name, 'utf-8') > MAX_IDENTIFIER_BYTES) {
    throw new SnapshotError(
      'SNAPSHOT_FAILED',
      `the copy of database "${database}" would be named "${name}", longer than the ` +
        `${MAX_IDENTIFIER_BYTES} bytes PostgreSQL allows: use a shorter database name.`,
    );
  }
  return name;
}

/** The names `snapshotName` makes for `database`, and only those. */
function snapshotPattern(database: string): RegExp {
  const escaped = database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}_snap_\\d{17}_(\\d+|none)$`);
}

/**
 * Free disk a copy of `sizeBytes` needs: the copy itself, as much again in
 * write-ahead log while it is written (the default WAL_LOG strategy logs every
 * block it copies), and a fixed margin for the migration that follows.
 */
export function snapshotSpaceNeeded(sizeBytes: number): number {
  return 2 * sizeBytes + SNAPSHOT_MARGIN_BYTES;
}

export const SNAPSHOT_MARGIN_BYTES = 256 * 1024 * 1024;

/** `123456789` → `117.7 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

// ─── Connections ─────────────────────────────────────────────────────────────

interface Target {
  /** The database the URL names. */
  readonly database: string;
  /** The same server, database `postgres`: a copy or a rename cannot be done from the database itself. */
  readonly maintenanceUrl: string;
}

function targetOf(connectionString: string): Target {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new SnapshotError('SNAPSHOT_FAILED', 'the connection string names no database.');
  }
  url.pathname = '/postgres';
  return { database, maintenanceUrl: url.toString() };
}

function connect(url: string): postgres.Sql {
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function withConnection<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = connect(url);
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlStateOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The client sessions connected to `database`, other than the asking one. */
async function otherSessions(sql: postgres.Sql, database: string): Promise<string[]> {
  const rows = await sql<{ pid: number; application_name: string | null; client: string | null }[]>`
    SELECT pid, application_name, client_addr::text AS client
    FROM pg_stat_activity
    WHERE datname = ${database}
      AND pid <> pg_backend_pid()
      AND backend_type = 'client backend'
    ORDER BY pid`;
  return rows.map(
    (r) =>
      `pid ${r.pid}${r.application_name ? ` (${r.application_name})` : ''}` +
      `${r.client ? ` from ${r.client}` : ''}`,
  );
}

function inUse(database: string, sessions: readonly string[]): SnapshotError {
  return new SnapshotError(
    'SNAPSHOT_SOURCE_IN_USE',
    `database "${database}" cannot be copied while another session is connected to it ` +
      `(${sessions.length > 0 ? sessions.join(', ') : 'a session that has since left'}). ` +
      `Stop what holds it (nodal-agents down stops Nodal's own services), then start again.`,
  );
}

/** The size of `database` on disk, in bytes. */
export async function databaseSizeBytes(connectionString: string): Promise<number> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  return withConnection(maintenanceUrl, async (sql) => {
    const [row] = await sql<{ size: string }[]>`SELECT pg_database_size(${database})::text AS size`;
    return Number(row?.size ?? 0);
  });
}

/**
 * True when any table of the database holds a row. A database nothing ever
 * migrated holds none, and needs no copy; one that was migrated holds at least
 * its migration history.
 */
export async function databaseHoldsRows(connectionString: string): Promise<boolean> {
  return withConnection(connectionString, async (sql) => {
    const tables = await sql<{ schema: string; table: string }[]>`
      SELECT n.nspname AS schema, c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY n.nspname, c.relname`;
    for (const t of tables) {
      const [row] = await sql.unsafe<{ any: boolean }[]>(
        `SELECT EXISTS (SELECT 1 FROM ${ident(t.schema)}.${ident(t.table)}) AS any`,
      );
      if (row?.any === true) return true;
    }
    return false;
  });
}

// ─── State files ─────────────────────────────────────────────────────────────

/** Read a live state file's bytes, or `null` when it does not exist. */
function readLive(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Copy the live state files into `<dir>/<name>/`; returns the names copied. */
function saveStateFiles(stateFiles: SnapshotStateFiles, name: string): string[] {
  const live = new Map<string, string>();
  for (const file of stateFiles.files) {
    const text = readLive(file.path);
    if (text !== null) live.set(file.name, text);
  }
  return saveStateTexts(stateFiles, name, live);
}

/** Write `texts` (state file name to content) into `<dir>/<name>/`; returns the names written. */
function saveStateTexts(
  stateFiles: SnapshotStateFiles,
  name: string,
  texts: ReadonlyMap<string, string>,
): string[] {
  const folder = join(stateFiles.dir, name);
  const saved: string[] = [];
  for (const file of stateFiles.files) {
    const text = texts.get(file.name);
    if (text === undefined) continue;
    // Parsed by the file's own reader before a byte is written: a copy that
    // could not be read back is never made.
    createStateFile(join(folder, file.name), text, file.spec);
    saved.push(file.name);
  }
  return saved;
}

function removeStateFiles(stateFiles: { dir: string }, name: string): void {
  rmSync(join(stateFiles.dir, name), { recursive: true, force: true });
}

// ─── Make ────────────────────────────────────────────────────────────────────

export interface CreateSnapshotInput {
  readonly at: Date;
  readonly kind: SnapshotKind;
  readonly lastMigration: string | null;
  readonly lastOpenedBy: string | null;
  readonly madeBy: string;
  readonly stateFiles: SnapshotStateFiles;
  /** Free bytes where the cluster writes (its data directory's volume). */
  readonly freeBytes: () => number | Promise<number>;
}

/**
 * Copy the database named by `connectionString` inside its cluster, with its
 * state files. Throws `SnapshotError` when it cannot, and leaves nothing
 * behind then: no half copy, no state folder.
 */
export async function createSnapshot(
  connectionString: string,
  input: CreateSnapshotInput,
): Promise<Snapshot> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  const name = snapshotName(database, input.at, input.lastMigration);
  const stateDir = join(input.stateFiles.dir, name);

  return withConnection(maintenanceUrl, async (sql) => {
    const [row] = await sql<{ size: string }[]>`SELECT pg_database_size(${database})::text AS size`;
    const sizeBytes = Number(row?.size ?? 0);
    const free = await input.freeBytes();
    const needed = snapshotSpaceNeeded(sizeBytes);
    if (free < needed) {
      throw new SnapshotError(
        'SNAPSHOT_NO_SPACE',
        `a copy of database "${database}" takes ${formatBytes(sizeBytes)}, and as much again ` +
          `in write-ahead log while it is written; with a ${formatBytes(SNAPSHOT_MARGIN_BYTES)} ` +
          `margin for the migration, ${formatBytes(needed)} must be free, and ` +
          `${formatBytes(free)} are. Free some disk space, then start again.`,
      );
    }

    // No pre-check of the sessions: PostgreSQL itself waits a few seconds for
    // other backends of the source to leave before refusing (55006), so a
    // session that is closing is not mistaken for one that holds it.
    try {
      await sql.unsafe(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(database)}`).simple();
    } catch (err) {
      const state = sqlStateOf(err);
      if (state === '55006') throw inUse(database, await otherSessions(sql, database));
      if (state === '42501') {
        throw new SnapshotError(
          'SNAPSHOT_NOT_PERMITTED',
          `the database user may not create databases (${reasonOf(err)}), so no copy of ` +
            `"${database}" can be made in its cluster.`,
        );
      }
      if (state === '53100') {
        throw new SnapshotError(
          'SNAPSHOT_NO_SPACE',
          `the disk filled while copying database "${database}" (${reasonOf(err)}). ` +
            `Free some disk space, then start again.`,
        );
      }
      throw new SnapshotError(
        'SNAPSHOT_FAILED',
        `could not copy database "${database}": ${reasonOf(err)}`,
      );
    }

    let saved: string[];
    try {
      saved = saveStateFiles(input.stateFiles, name);
      const meta: SnapshotMeta = {
        nodalSnapshot: 1,
        of: database,
        kind: input.kind,
        at: input.at.toISOString(),
        lastMigration: input.lastMigration,
        lastOpenedBy: input.lastOpenedBy,
        madeBy: input.madeBy,
        stateFiles: saved,
      };
      await sql.unsafe(`COMMENT ON DATABASE ${ident(name)} IS ${literal(JSON.stringify(meta))}`);
      return { name, sizeBytes, meta, stateDir };
    } catch (err) {
      // Nothing half-made stays behind.
      await sql
        .unsafe(`DROP DATABASE IF EXISTS ${ident(name)}`)
        .simple()
        .catch(() => undefined);
      removeStateFiles(input.stateFiles, name);
      throw new SnapshotError(
        'SNAPSHOT_FAILED',
        `the copy of database "${database}" could not be completed: ${reasonOf(err)}`,
      );
    }
  });
}

// ─── A copy filled from elsewhere (a restore) ────────────────────────────────

/** The connection string of database `name` on the same server as `connectionString`. */
export function databaseUrlOf(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

/**
 * An EMPTY database under a snapshot name of `connectionString`'s database,
 * for a restore to fill. It has no description, so until `completeSnapshot`
 * it is listed as an incomplete copy (never swapped in, dropped by the next
 * prune). Made from `template0`: nothing but what the restore puts in it.
 */
export async function createEmptySnapshot(
  connectionString: string,
  input: { readonly at: Date; readonly lastMigration: string | null },
): Promise<{ readonly name: string; readonly url: string }> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  const name = snapshotName(database, input.at, input.lastMigration);
  await withConnection(maintenanceUrl, async (sql) => {
    try {
      await sql.unsafe(`CREATE DATABASE ${ident(name)} TEMPLATE template0`).simple();
    } catch (err) {
      if (sqlStateOf(err) === '42501') {
        throw new SnapshotError(
          'SNAPSHOT_NOT_PERMITTED',
          `the database user may not create databases (${reasonOf(err)}), so nothing can be ` +
            `restored into the cluster of "${database}".`,
        );
      }
      throw new SnapshotError(
        'SNAPSHOT_FAILED',
        `could not create database "${name}" to restore into: ${reasonOf(err)}`,
      );
    }
  });
  return { name, url: databaseUrlOf(connectionString, name) };
}

/**
 * Describe the copy `name` (made by `createEmptySnapshot` and filled since),
 * with `texts` (state file name to content) saved beside it the way every
 * copy's are. From then on it is a complete copy: listed, kept, and swapped
 * in by `restoreSnapshot`.
 */
export async function completeSnapshot(
  connectionString: string,
  name: string,
  input: {
    readonly at: Date;
    readonly kind: SnapshotKind;
    readonly lastMigration: string | null;
    readonly lastOpenedBy: string | null;
    readonly madeBy: string;
    readonly stateFiles: SnapshotStateFiles;
    readonly texts: ReadonlyMap<string, string>;
  },
): Promise<Snapshot> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  const saved = saveStateTexts(input.stateFiles, name, input.texts);
  const meta: SnapshotMeta = {
    nodalSnapshot: 1,
    of: database,
    kind: input.kind,
    at: input.at.toISOString(),
    lastMigration: input.lastMigration,
    lastOpenedBy: input.lastOpenedBy,
    madeBy: input.madeBy,
    stateFiles: saved,
  };
  try {
    return await withConnection(maintenanceUrl, async (sql) => {
      await sql.unsafe(`COMMENT ON DATABASE ${ident(name)} IS ${literal(JSON.stringify(meta))}`);
      const [row] = await sql<{ size: string }[]>`SELECT pg_database_size(${name})::text AS size`;
      return {
        name,
        sizeBytes: Number(row?.size ?? 0),
        meta,
        stateDir: join(input.stateFiles.dir, name),
      };
    });
  } catch (err) {
    removeStateFiles(input.stateFiles, name);
    throw new SnapshotError(
      'SNAPSHOT_FAILED',
      `could not describe copy "${name}": ${reasonOf(err)}`,
    );
  }
}

/**
 * Drop the copy `name` and its state folder, whatever is connected to it: a
 * restore that failed half-way removes what it made, and only that.
 */
export async function dropSnapshot(
  connectionString: string,
  name: string,
  stateFilesDir: string,
): Promise<void> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  if (!snapshotPattern(database).test(name)) {
    throw new SnapshotError('SNAPSHOT_NOT_FOUND', `"${name}" is not a copy of "${database}".`);
  }
  await withConnection(maintenanceUrl, (sql) =>
    sql.unsafe(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`).simple(),
  );
  removeStateFiles({ dir: stateFilesDir }, name);
}

// ─── List and prune ──────────────────────────────────────────────────────────

function parseMeta(comment: string | null, database: string): SnapshotMeta | null {
  if (comment === null) return null;
  try {
    const m = JSON.parse(comment) as Partial<SnapshotMeta>;
    if (m.nodalSnapshot !== 1 || m.of !== database || typeof m.at !== 'string') return null;
    return {
      nodalSnapshot: 1,
      of: m.of,
      kind: SNAPSHOT_KINDS.find((k) => k === m.kind) ?? 'before-migration',
      at: m.at,
      lastMigration: typeof m.lastMigration === 'string' ? m.lastMigration : null,
      lastOpenedBy: typeof m.lastOpenedBy === 'string' ? m.lastOpenedBy : null,
      madeBy: typeof m.madeBy === 'string' ? m.madeBy : '',
      stateFiles: Array.isArray(m.stateFiles)
        ? m.stateFiles.filter((f): f is string => typeof f === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

async function listWith(
  sql: postgres.Sql,
  database: string,
  stateFilesDir: string,
): Promise<Snapshot[]> {
  const rows = await sql<{ name: string; comment: string | null; size: string }[]>`
    SELECT datname AS name,
           shobj_description(oid, 'pg_database') AS comment,
           pg_database_size(oid)::text AS size
    FROM pg_database
    WHERE datname LIKE ${`${database.replace(/[\\_%]/g, '\\$&')}\\_snap\\_%`}`;
  const pattern = snapshotPattern(database);
  return rows
    .filter((r) => pattern.test(r.name))
    .map((r) => ({
      name: r.name,
      sizeBytes: Number(r.size),
      meta: parseMeta(r.comment, database),
      stateDir: join(stateFilesDir, r.name),
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * The copies of the database named by `connectionString`, newest first (the
 * name starts with the time it was taken). An incomplete copy has `meta: null`.
 */
export async function listSnapshots(
  connectionString: string,
  stateFilesDir: string,
): Promise<Snapshot[]> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  return withConnection(maintenanceUrl, (sql) => listWith(sql, database, stateFilesDir));
}

/**
 * Keep the `keep` newest complete copies; drop the others and every incomplete
 * one, with their state folders. Called only once a NEW copy is complete, so
 * the count never drops below what existed before. Returns the names dropped.
 */
export async function pruneSnapshots(
  connectionString: string,
  opts: { keep: number; stateFilesDir: string },
): Promise<string[]> {
  if (!Number.isInteger(opts.keep) || opts.keep < 1) {
    throw new SnapshotError(
      'SNAPSHOT_FAILED',
      `snapshots.keep must be a whole number of at least 1, not ${opts.keep}.`,
    );
  }
  const { database, maintenanceUrl } = targetOf(connectionString);
  return withConnection(maintenanceUrl, async (sql) => {
    const all = await listWith(sql, database, opts.stateFilesDir);
    const complete = all.filter((s) => s.meta !== null);
    const drop = [...complete.slice(opts.keep), ...all.filter((s) => s.meta === null)];
    for (const s of drop) {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${ident(s.name)}`).simple();
      removeStateFiles({ dir: opts.stateFilesDir }, s.name);
    }
    // A state folder whose copy is no longer in the cluster (the snapshot a
    // rollback swapped in became the database itself): its files were kept
    // until now so the person could look at them; they go with this prune.
    const kept = new Set(all.map((s) => s.name));
    const pattern = snapshotPattern(database);
    if (existsSync(opts.stateFilesDir)) {
      for (const folder of readdirSync(opts.stateFilesDir)) {
        if (pattern.test(folder) && !kept.has(folder)) {
          removeStateFiles({ dir: opts.stateFilesDir }, folder);
        }
      }
    }
    return drop.map((s) => s.name);
  });
}

// ─── Go back ─────────────────────────────────────────────────────────────────

export interface RestoreSnapshotInput {
  readonly at: Date;
  readonly madeBy: string;
  readonly stateFiles: SnapshotStateFiles;
  /** The newest migration the CURRENT database holds, for the name of the copy it becomes. */
  readonly currentLastMigration: string | null;
  /** The version that last opened the current database, when recorded. */
  readonly currentOpenedBy: string | null;
  /** Why the current database is set aside: a rollback (default) or a restore from a backup. */
  readonly replacedKind?: 'replaced-by-rollback' | 'replaced-by-restore';
}

/** A live state file the swap made the copy's (the master key). */
export interface PutBackFile {
  readonly path: string;
  /** `missing`: there was none. `replaced`: the previous one is saved beside the replaced database. */
  readonly previous: 'missing' | 'replaced';
}

export interface RestoreSnapshotResult {
  /** The snapshot that is now the database. */
  readonly restored: Snapshot;
  /** The copy the replaced database became. */
  readonly replaced: Snapshot;
  /** Live files the swap made the copy's (the master key). */
  readonly putBack: readonly PutBackFile[];
}

/**
 * Swap `name` back in as the database named by `connectionString`. The
 * current database is kept as a copy of its own; nothing is dropped.
 */
export async function restoreSnapshot(
  connectionString: string,
  name: string,
  input: RestoreSnapshotInput,
): Promise<RestoreSnapshotResult> {
  const { database, maintenanceUrl } = targetOf(connectionString);
  const replacedName = snapshotName(database, input.at, input.currentLastMigration);

  return withConnection(maintenanceUrl, async (sql) => {
    const all = await listWith(sql, database, input.stateFiles.dir);
    const chosen = all.find((s) => s.name === name);
    if (chosen === undefined || chosen.meta === null) {
      throw new SnapshotError(
        'SNAPSHOT_NOT_FOUND',
        chosen === undefined
          ? `no snapshot of database "${database}" is named "${name}".`
          : `"${name}" is a copy that was never completed; it cannot be put back.`,
      );
    }

    // The files the database depends on (the master key) travel with it. Read
    // and parsed BEFORE anything moves: a saved copy that cannot be read
    // refuses the swap. The live ones are saved beside the replaced database
    // just below, so neither database is left without its key.
    const toPut: {
      path: string;
      text: string;
      spec: StateFileSpec<unknown>;
      previous: 'missing' | 'replaced';
    }[] = [];
    for (const file of input.stateFiles.files) {
      if (!file.boundToDatabase || !chosen.meta.stateFiles.includes(file.name)) continue;
      const savedPath = join(chosen.stateDir, file.name);
      const saved = readFileSync(savedPath, 'utf-8');
      try {
        file.spec.parse(saved);
      } catch (err) {
        throw new SnapshotError(
          'SNAPSHOT_FAILED',
          `${file.spec.label} saved with "${name}" (${savedPath}) is not usable ` +
            `(${reasonOf(err)}). Nothing was swapped.`,
        );
      }
      const live = readLive(file.path);
      if (live === null) {
        toPut.push({ path: file.path, text: saved, spec: file.spec, previous: 'missing' });
      } else if (saved.trim() !== live.trim()) {
        toPut.push({ path: file.path, text: saved, spec: file.spec, previous: 'replaced' });
      }
    }

    // The replaced database's state files, saved like any snapshot's, first.
    const saved = saveStateFiles(input.stateFiles, replacedName);
    const replacedMeta: SnapshotMeta = {
      nodalSnapshot: 1,
      of: database,
      kind: input.replacedKind ?? 'replaced-by-rollback',
      at: input.at.toISOString(),
      lastMigration: input.currentLastMigration,
      lastOpenedBy: input.currentOpenedBy,
      madeBy: input.madeBy,
      stateFiles: saved,
    };
    try {
      // One transaction: either both names moved and both descriptions are
      // right, or nothing changed.
      await sql.begin(async (tx) => {
        await tx.unsafe(`ALTER DATABASE ${ident(database)} RENAME TO ${ident(replacedName)}`);
        await tx.unsafe(`ALTER DATABASE ${ident(name)} RENAME TO ${ident(database)}`);
        await tx.unsafe(
          `COMMENT ON DATABASE ${ident(replacedName)} IS ${literal(JSON.stringify(replacedMeta))}`,
        );
        await tx.unsafe(`COMMENT ON DATABASE ${ident(database)} IS NULL`);
      });
    } catch (err) {
      removeStateFiles(input.stateFiles, replacedName);
      const state = sqlStateOf(err);
      if (state === '55006') {
        throw inUse(database, [
          ...(await otherSessions(sql, database)),
          ...(await otherSessions(sql, name)),
        ]);
      }
      throw new SnapshotError(
        'SNAPSHOT_FAILED',
        `could not swap "${name}" in for database "${database}": ${reasonOf(err)}. ` +
          `Nothing was changed.`,
      );
    }

    // After the swap: a stop between the two leaves the new database with the
    // old key, which the next start refuses loudly (master-key-guard), and the
    // right key is still in the chosen copy's folder.
    for (const file of toPut) {
      if (file.previous === 'missing') createStateFile(file.path, file.text, file.spec);
      else replaceStateFile(file.path, file.text, file.spec);
    }

    const [size] = await sql<{ size: string }[]>`
      SELECT pg_database_size(${replacedName})::text AS size`;
    return {
      restored: chosen,
      replaced: {
        name: replacedName,
        sizeBytes: Number(size?.size ?? 0),
        meta: replacedMeta,
        stateDir: join(input.stateFiles.dir, replacedName),
      },
      putBack: toPut.map((f) => ({ path: f.path, previous: f.previous })),
    };
  });
}
