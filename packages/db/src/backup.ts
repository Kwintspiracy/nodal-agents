// backup.ts — one file that holds everything an install needs to live again,
// and the way it comes back, on this machine or another.
//
// THE RULE. A backup that cannot be restored is refused when it is made, not
// discovered when it is needed:
//
//   - it refuses a database this program cannot rebuild the schema of (newer
//     than the program, or never migrated), and a master key that does not
//     open the database's secrets: either archive could not be restored;
//   - it is written to a temporary name beside its final one, READ BACK and
//     compared with the database (row count and SHA-256 of every table, every
//     state file, every workspace file), and only then renamed to its final
//     name. An interrupted backup, or one whose read-back differs, leaves no
//     file that looks complete: the temporary one is removed, and a crash
//     leaves a dot-named `.partial` that no listing takes for a backup.
//
// WHAT IS IN IT (format: backup-archive.ts). The rows of every table of every
// schema, the migration history included (that history IS the schema's
// identity), the position of every sequence, the state files that must travel
// with the rows (the master key their secrets are encrypted with, the
// config), and, on request, the home's workspaces folder.
//
// HOW EACH COLUMN TYPE SURVIVES. Rows are read with `COPY … TO STDOUT` and
// written back with `COPY … FROM STDIN`, in PostgreSQL's text format, through
// the driver: no dump tool is needed (the embedded cluster ships none), and
// the text format does not depend on the server's major version, so the same
// archive is the path to a new major version (restore into a new cluster).
// Every value goes through its type's own output and input functions:
//
//   - json / jsonb: their text, byte for byte for json, canonical for jsonb;
//   - timestamps with zone: written with the session in UTC, so the archive
//     holds `…+00` and reads back to the same instant whatever the zone of
//     either machine;
//   - bytea: hex (`bytea_output = hex`), the unambiguous form;
//   - floats: `extra_float_digits = 3`, the exact form pg_dump uses;
//   - generated columns (the `tsvector` search columns): NOT stored. They are
//     left out of both column lists and recomputed by the server as the rows
//     come back, from the restored values;
//   - vectors: with pgvector, a `vector(N)` column writes `[x,y,…]`; without
//     it, the migrations make that column `text` holding the same notation.
//     Either archive restores into either kind of install: the target's own
//     input function reads the notation, and a value it cannot read fails the
//     restore loudly;
//   - sequences: their position is read after the rows, so it is at or past
//     every value the rows hold, and set back with `setval`.
//
// RESTORE (`restoreBackup`). Into an EMPTY copy, never over the live database:
//
//   1. The archive's schema history is read against this program's journal.
//      A migration the journal does not have: refused, the message names both
//      versions, before anything is created.
//   2. The schema the archive was taken at is built in the empty copy by the
//      normal path (`migrateDatabase`, over a journal holding exactly the
//      archive's history), then the rows go in, in one transaction, with
//      triggers and foreign-key checks off (`session_replication_role =
//      replica`, as a data-only restore needs: the rows are already
//      consistent and some tables reference each other both ways), and every
//      table is counted against the archive.
//   3. The archive's master key must open the copy's secrets (a decryption):
//      a missing or wrong key is refused, and the copy dropped, BEFORE
//      anything is replaced.
//   4. The copy is swapped in (snapshots.ts): the database it replaces is
//      KEPT as a copy of its own, with the live key and config beside it, and
//      the archive's key becomes the live one.
//   5. The restored database is migrated to this program's schema by the
//      normal path (with the copy before it, like any `up`), and ends by
//      proving a stored credential decrypts with the restored key.
//
// The database it works on is reached through its connection string only:
// the embedded cluster or any PostgreSQL. A restore needs the right to create
// a database and to turn triggers off for its session (a superuser, which the
// embedded cluster's user is); without either it is refused with the server's
// reason, and nothing is replaced.

import postgres from 'postgres';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MASTER_KEY_FILE, readMasterKeyFile } from '@nodal-agents/secrets';
import {
  BackupError,
  BackupReader,
  BackupWriter,
  type BackupManifest,
  type BackupRecordDigest,
  type BackupRecordHeader,
  type BackupSequence,
} from './backup-archive.ts';
import { migrationsFolderFor, readProgramJournal, type RunMigrationsOptions } from './migrate.ts';
import { readOpenedBy, readSchemaState, schemaStateOf } from './schema-state.ts';
import { migrateDatabase, type MigrateDatabaseResult } from './safe-migrate.ts';
import {
  completeSnapshot,
  createEmptySnapshot,
  dropSnapshot,
  restoreSnapshot,
  type PutBackFile,
  type Snapshot,
  type SnapshotStateFile,
  type SnapshotStateFiles,
} from './snapshots.ts';
import { createClient } from './client.ts';
import { assertMasterKeyRestorable, checkMasterKey } from './queries/master-key-guard.ts';

export {
  BackupError,
  readBackupHeader,
  type BackupErrorCode,
  type BackupManifest,
} from './backup-archive.ts';

// ─── Names ───────────────────────────────────────────────────────────────────

const BACKUP_FILE = /^nodal-backup-(\d{8}T\d{9}Z)\.nodalbak$/;
/** The temporary name a backup is written under, with the pid of the process writing it. */
const PARTIAL_FILE = /^\.nodal-backup-\d{8}T\d{9}Z\.nodalbak\.(\d+)\.[0-9a-f]{8}\.partial$/;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove the temporary files of backups whose process is gone (killed, power
 * cut): they hold a database and its key, and are never a backup. A file of a
 * process still alive is another backup being written, and is left alone.
 */
function removeDeadPartials(dir: string): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const pid = PARTIAL_FILE.exec(name)?.[1];
    if (pid === undefined || pidAlive(Number(pid))) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

function stamp(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}T` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}` +
    `${p(at.getUTCMilliseconds(), 3)}Z`
  );
}

/** The file name of a backup taken at `at`. */
export function backupFileName(at: Date): string {
  return `nodal-backup-${stamp(at)}.nodalbak`;
}

export interface BackupFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

/** The backups in `dir`, newest first. Only files named by `backupFileName` count. */
export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort((a, b) => b.localeCompare(a))
    .map((name) => ({ name, path: join(dir, name), bytes: statSync(join(dir, name)).size }))
    .filter((f) => f.bytes > 0);
}

/**
 * Keep the `keep` newest backups of `dir`, remove the others. Called only once
 * a NEW backup is verified and published, so the count never drops below what
 * existed before. Returns the names removed.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupError(
      'BACKUP_FAILED',
      `--keep must be a whole number of at least 1, not ${keep}.`,
    );
  }
  const drop = listBackups(dir).slice(keep);
  for (const f of drop) rmSync(f.path, { force: true });
  return drop.map((f) => f.name);
}

// ─── The database, through the driver ────────────────────────────────────────

/** The session every read and write of rows runs in: values in their unambiguous forms. */
const SESSION = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  'SET LOCAL extra_float_digits = 3',
  "SET LOCAL bytea_output = 'hex'",
  "SET LOCAL client_encoding = 'UTF8'",
];

interface TableShape {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly types: readonly string[];
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

function key(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sqlStateOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Every ordinary table of the database outside the system schemas and outside
 * extensions, with its stored columns (generated ones left out), in a stable
 * order.
 */
async function tableShapes(sql: postgres.Sql | postgres.TransactionSql): Promise<TableShape[]> {
  const rows = await sql<{ schema: string; table: string; columns: string[]; types: string[] }[]>`
    SELECT n.nspname AS schema, c.relname AS table,
           coalesce(array_agg(a.attname::text ORDER BY a.attnum)
                    FILTER (WHERE a.attnum IS NOT NULL), '{}') AS columns,
           coalesce(array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum)
                    FILTER (WHERE a.attnum IS NOT NULL), '{}') AS types
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a
      ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
    WHERE c.relkind = 'r'
      AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    GROUP BY n.nspname, c.relname
    ORDER BY n.nspname, c.relname`;
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    columns: r.columns,
    types: r.types,
  }));
}

async function sequenceNames(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<{ schema: string; name: string }[]> {
  return sql<{ schema: string; name: string }[]>`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY n.nspname, c.relname`;
}

async function hasVector(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`;
  return row?.ok === true;
}

function connect(url: string): postgres.Sql {
  return postgres(url, { max: 1, onnotice: () => {} });
}

// ─── State files ─────────────────────────────────────────────────────────────

function masterKeyEntry(stateFiles: SnapshotStateFiles): SnapshotStateFile | undefined {
  return stateFiles.files.find((f) => f.spec === MASTER_KEY_FILE);
}

/** The live state files' contents, each parsed by its own reader first. */
function readLiveStateFiles(stateFiles: SnapshotStateFiles): Map<string, string> {
  const texts = new Map<string, string>();
  for (const file of stateFiles.files) {
    let text: string;
    try {
      text = readFileText(file.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    try {
      file.spec.parse(text);
    } catch (err) {
      throw new BackupError(
        'BACKUP_SOURCE_UNUSABLE',
        `${file.spec.label} at ${file.path} is not valid (${reasonOf(err)}); a backup holding it ` +
          'could not be restored. Nothing was written.',
      );
    }
    texts.set(file.name, text);
  }
  return texts;
}

function readFileText(path: string): string {
  return readFileSync(path, 'utf-8');
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

interface TreeEntry {
  readonly kind: 'dir' | 'file';
  /** POSIX path relative to the root. */
  readonly path: string;
  readonly full: string;
}

/** The folders and regular files under `root`, parents first; anything else is listed in `skipped`. */
function walkTree(root: string): { entries: TreeEntry[]; skipped: string[] } {
  const entries: TreeEntry[] = [];
  const skipped: string[] = [];
  const visit = (full: string, rel: string): void => {
    for (const name of readdirSync(full).sort()) {
      const childFull = join(full, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(childFull);
      if (st.isDirectory()) {
        entries.push({ kind: 'dir', path: childRel, full: childFull });
        visit(childFull, childRel);
      } else if (st.isFile()) {
        entries.push({ kind: 'file', path: childRel, full: childFull });
      } else {
        skipped.push(childRel);
      }
    }
  };
  visit(root, '');
  return { entries, skipped };
}

/** `rel` as a path under `root`, or a refusal: an archive never writes outside its folder. */
function insideFolder(root: string, rel: string, archive: string): string {
  const parts = rel.split('/');
  const bad =
    rel === '' ||
    rel.includes('\\') ||
    rel.includes('\0') ||
    parts.some((p) => p === '' || p === '.' || p === '..' || /^[A-Za-z]:/.test(p));
  const full = resolve(root, ...parts);
  if (bad || !(full + sep).startsWith(resolve(root) + sep)) {
    throw new BackupError(
      'BACKUP_DAMAGED',
      `${archive}: a workspace entry names "${rel}", outside its folder.`,
    );
  }
  return full;
}

// ─── Make ────────────────────────────────────────────────────────────────────

/** The points a test can stop a backup at, to prove what an interruption leaves. */
export type BackupStep =
  | 'started'
  | 'manifest'
  | 'state-files'
  | 'table'
  | 'sequences'
  | 'workspaces'
  | 'written'
  | 'verified';

export interface BackupSeams {
  readonly at?: (step: BackupStep) => void | Promise<void>;
  /** After the file is written and closed, before it is read back. */
  readonly beforeVerify?: (tempPath: string) => void | Promise<void>;
}

export interface CreateBackupOptions extends Pick<RunMigrationsOptions, 'migrationsFolder'> {
  /** The folder the archive is written to. Created if missing. */
  readonly dir: string;
  /** The state files that travel with the rows (`homeStateFiles()`). */
  readonly stateFiles: SnapshotStateFiles;
  /** The home's workspaces folder, to include it; omitted, it is not. */
  readonly workspacesDir?: string;
  /** Encrypt the archive with this passphrase. */
  readonly passphrase?: string;
  /** This program's version, recorded as the one that made it. */
  readonly programVersion: string;
  /** Keep only the newest N backups of `dir` once this one is published. */
  readonly keep?: number;
  readonly now?: () => Date;
  readonly onStep?: (text: string) => void;
  readonly seams?: BackupSeams;
}

export interface BackedUpTable {
  readonly schema: string;
  readonly table: string;
  readonly rows: number;
  readonly sha256: string;
}

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly encrypted: boolean;
  readonly manifest: BackupManifest;
  readonly tables: readonly BackedUpTable[];
  readonly rows: number;
  readonly sequences: number;
  /** The state files inside, by name. */
  readonly stateFiles: readonly string[];
  /** What the key check decrypted (null: the database holds no encrypted value). */
  readonly keyProof: string | null;
  readonly workspaces: {
    readonly files: number;
    readonly dirs: number;
    readonly bytes: number;
    /** Entries that are neither a folder nor a regular file (links…), not copied. */
    readonly skipped: readonly string[];
  } | null;
  /** Older backups removed by `keep`. */
  readonly pruned: readonly string[];
}

/** One record as the source gave it: what the read-back must find. */
interface Expected {
  readonly label: string;
  readonly kind: BackupRecordHeader['kind'];
  readonly digest: BackupRecordDigest;
  /** For a table: the rows the database counted in the same snapshot. */
  readonly rows?: number;
}

function labelOf(h: BackupRecordHeader): string {
  switch (h.kind) {
    case 'table':
      return `table ${key(h.schema, h.table)}`;
    case 'state-file':
      return `file ${h.name}`;
    case 'workspace-dir':
    case 'workspace-file':
      return `workspace ${h.path}`;
    default:
      return h.kind;
  }
}

/** POSIX: flush the folder so the renamed entry survives a power cut. */
function syncFolder(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* a file system that cannot sync a folder: the file itself is flushed */
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Write a verified backup of the database named by `connectionString` into
 * `opts.dir`. Throws `BackupError` when it cannot; nothing with a backup's
 * name is left behind then.
 */
export async function createBackup(
  connectionString: string,
  opts: CreateBackupOptions,
): Promise<BackupResult> {
  const now = opts.now ?? ((): Date => new Date());
  const at = now();
  mkdirSync(opts.dir, { recursive: true });
  removeDeadPartials(opts.dir);
  const finalPath = join(opts.dir, backupFileName(at));
  if (existsSync(finalPath)) {
    throw new BackupError(
      'BACKUP_DESTINATION_EXISTS',
      `${finalPath} already exists; nothing was written.`,
    );
  }

  // 1. What would make the archive impossible to restore, refused first.
  opts.onStep?.('Reading the database schema…');
  const state = await readSchemaState(connectionString, opts);
  if (state.applied === null || state.applied.length === 0) {
    throw new BackupError(
      'BACKUP_SOURCE_UNUSABLE',
      'this database was never migrated: it holds no Nodal-Agents schema to back up.',
    );
  }
  // Newer means a migration LATER than this program's newest one. A history
  // row no journal claims that is older (a development branch's migration,
  // renumbered or dropped since) is not newer: it is backed up with the rest
  // of the history, as `up` starts on it (schema-state.ts).
  if (state.ahead.length > 0) {
    const opened = await readOpenedBy(connectionString);
    const who =
      opened !== null && opened !== 'unreadable' ? `version ${opened.version}` : 'a newer version';
    throw new BackupError(
      'BACKUP_NEWER_THAN_PROGRAM',
      `this database holds ${state.ahead.length} migration(s) later than any this program (${opts.programVersion}) knows: ` +
        `it was migrated by ${who}. A backup made by this program could not be ` +
        'restored by it. Back it up with the version that migrated it. Nothing was written.',
    );
  }
  const texts = readLiveStateFiles(opts.stateFiles);
  const keyFile = masterKeyEntry(opts.stateFiles);
  const keyText = keyFile === undefined ? undefined : texts.get(keyFile.name);
  const liveKey = keyText === undefined ? null : MASTER_KEY_FILE.parse(keyText);
  let keyProof: string | null;
  {
    const { db, close } = createClient(connectionString, { max: 1 });
    try {
      const verdict = await checkMasterKey(db, liveKey);
      if (!verdict.opens) {
        throw new BackupError(
          verdict.reason === 'missing' ? 'BACKUP_KEY_MISSING' : 'BACKUP_KEY_DOES_NOT_OPEN',
          verdict.reason === 'missing'
            ? `the database holds ${verdict.what} encrypted with a master key, and there is no ` +
                `master key file${keyFile ? ` at ${keyFile.path}` : ''}. A backup without it could ` +
                'not be restored. Nothing was written.'
            : `the master key file${keyFile ? ` ${keyFile.path}` : ''} does not open the ` +
                `database's secrets (${verdict.what} does not decrypt with it). A backup holding ` +
                'it could not be restored. Nothing was written.',
        );
      }
      keyProof = verdict.proof;
    } finally {
      await close();
    }
  }

  // 2. Written under a temporary name, in the same folder.
  const temp = join(
    opts.dir,
    `.${backupFileName(at)}.${process.pid}.${randomBytes(4).toString('hex')}.partial`,
  );
  const expected: Expected[] = [];
  const tables: BackedUpTable[] = [];
  let manifest: BackupManifest | null = null;
  let sequences = 0;
  let workspaces: BackupResult['workspaces'] = null;
  let writer: BackupWriter | null = null;
  try {
    writer = await BackupWriter.create(
      temp,
      opts.passphrase === undefined ? {} : { passphrase: opts.passphrase },
    );
    const w = writer;
    await opts.seams?.at?.('started');
    const record = async (
      header: BackupRecordHeader,
      payload?: Parameters<BackupWriter['record']>[1],
    ): Promise<BackupRecordDigest> => {
      const digest = await w.record(header, payload);
      expected.push({ label: labelOf(header), kind: header.kind, digest });
      return digest;
    };

    const sql = connect(connectionString);
    try {
      // One snapshot for every table: the archive is the database at ONE instant,
      // even while the stack runs and writes.
      await sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
        for (const s of SESSION) await tx.unsafe(s);
        const history = (
          await tx<
            { created_at: string }[]
          >`SELECT created_at::text FROM drizzle.__drizzle_migrations`
        )
          .map((r) => Number(r.created_at))
          .sort((a, b) => a - b);
        const newest = history.at(-1);
        manifest = {
          madeBy: opts.programVersion,
          at: at.toISOString(),
          database: decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, '')),
          schema: {
            history,
            lastMigration:
              state.journal.find((e) => Number(e.when) === newest)?.tag ??
              state.lastClaimed?.tag ??
              null,
          },
          vector: await hasVector(tx),
          workspaces: opts.workspacesDir !== undefined,
        };
        await record({ kind: 'manifest', manifest });
        await opts.seams?.at?.('manifest');

        for (const file of opts.stateFiles.files) {
          const text = texts.get(file.name);
          if (text !== undefined) await record({ kind: 'state-file', name: file.name }, text);
        }
        await opts.seams?.at?.('state-files');

        const shapes = await tableShapes(tx);
        opts.onStep?.(`Writing ${shapes.length} tables…`);
        for (const t of shapes) {
          const [count] = await tx.unsafe<{ n: string }[]>(
            `SELECT count(*)::text AS n FROM ONLY ${qualified(t.schema, t.table)}`,
          );
          const rows = Number(count?.n ?? 0);
          const stream = await tx
            .unsafe(
              `COPY ${qualified(t.schema, t.table)} (${t.columns.map(ident).join(', ')}) TO STDOUT`,
            )
            .readable();
          const digest = await w.record(
            { kind: 'table', schema: t.schema, table: t.table, columns: t.columns, types: t.types },
            stream as AsyncIterable<Buffer>,
          );
          expected.push({ label: `table ${key(t.schema, t.table)}`, kind: 'table', digest, rows });
          if (digest.lines !== rows) {
            throw new BackupError(
              'BACKUP_FAILED',
              `table ${key(t.schema, t.table)}: the database counted ${rows} rows and sent ` +
                `${digest.lines}. Nothing was published.`,
            );
          }
          tables.push({ schema: t.schema, table: t.table, rows, sha256: digest.sha256 });
          await opts.seams?.at?.('table');
        }

        // After the rows: a sequence's position is then at or past every value they hold.
        const seqs: BackupSequence[] = [];
        for (const s of await sequenceNames(tx)) {
          const [row] = await tx.unsafe<{ last_value: string; is_called: boolean }[]>(
            `SELECT last_value::text AS last_value, is_called FROM ${qualified(s.schema, s.name)}`,
          );
          if (row !== undefined) {
            seqs.push({
              schema: s.schema,
              name: s.name,
              lastValue: row.last_value,
              isCalled: row.is_called,
            });
          }
        }
        sequences = seqs.length;
        await record({ kind: 'sequences' }, JSON.stringify(seqs));
        await opts.seams?.at?.('sequences');
      });
    } finally {
      await sql.end();
    }

    if (opts.workspacesDir !== undefined) {
      opts.onStep?.('Writing the workspaces…');
      const tree = existsSync(opts.workspacesDir)
        ? walkTree(opts.workspacesDir)
        : { entries: [], skipped: [] };
      let files = 0;
      let dirs = 0;
      let bytes = 0;
      for (const e of tree.entries) {
        if (e.kind === 'dir') {
          await record({ kind: 'workspace-dir', path: e.path });
          dirs++;
        } else {
          const d = await record(
            { kind: 'workspace-file', path: e.path },
            createReadStream(e.full) as AsyncIterable<Buffer>,
          );
          files++;
          bytes += d.bytes;
        }
      }
      workspaces = { files, dirs, bytes, skipped: tree.skipped };
      await opts.seams?.at?.('workspaces');
    }

    await w.finish();
    writer = null;
    await opts.seams?.at?.('written');

    // 3. Read back, compared with what the database gave.
    opts.onStep?.('Reading the backup back…');
    await opts.seams?.beforeVerify?.(temp);
    await verifyAgainst(temp, opts.passphrase, expected);
    await opts.seams?.at?.('verified');

    // 4. Published by rename: before this line no file has the final name.
    renameSync(temp, finalPath);
    syncFolder(opts.dir);
  } catch (err) {
    await writer?.abort();
    rmSync(temp, { force: true });
    if (err instanceof BackupError) throw err;
    if (sqlStateOf(err) === '42501') {
      throw new BackupError(
        'BACKUP_NOT_PERMITTED',
        `the database user may not read every table (${reasonOf(err)}). Nothing was written.`,
        { cause: err },
      );
    }
    throw new BackupError('BACKUP_FAILED', `${reasonOf(err)}. Nothing was written.`, {
      cause: err,
    });
  }

  const pruned = opts.keep === undefined ? [] : pruneBackups(opts.dir, opts.keep);
  if (manifest === null) throw new BackupError('BACKUP_FAILED', 'no manifest was written.');
  return {
    path: finalPath,
    bytes: statSync(finalPath).size,
    encrypted: opts.passphrase !== undefined,
    manifest,
    tables,
    rows: tables.reduce((n, t) => n + t.rows, 0),
    sequences,
    stateFiles: [...texts.keys()],
    keyProof,
    workspaces,
    pruned,
  };
}

/** Read `path` whole and compare every record with `expected`, in order. */
async function verifyAgainst(
  path: string,
  passphrase: string | undefined,
  expected: readonly Expected[],
): Promise<void> {
  const fail = (what: string, cause?: unknown): BackupError =>
    new BackupError(
      'BACKUP_VERIFY_FAILED',
      `read back, ${what}. The file was removed; nothing was published.`,
      cause === undefined ? undefined : { cause },
    );
  let reader: BackupReader;
  try {
    reader = await BackupReader.open(path, passphrase === undefined ? {} : { passphrase });
  } catch (err) {
    throw fail(`the backup could not be opened (${reasonOf(err)})`, err);
  }
  try {
    let i = 0;
    for (;;) {
      let header: BackupRecordHeader | null;
      try {
        header = await reader.next();
      } catch (err) {
        throw fail(`the backup is damaged (${reasonOf(err)})`, err);
      }
      if (header === null) break;
      const want = expected[i];
      const label = labelOf(header);
      if (want === undefined || want.label !== label) {
        throw fail(`record ${i + 1} is ${label}, where ${want?.label ?? 'the end'} was written`);
      }
      const sink: { digest?: BackupRecordDigest } = {};
      try {
        for await (const chunk of reader.payload(sink)) void chunk;
      } catch (err) {
        throw fail(`${label} is damaged (${reasonOf(err)})`, err);
      }
      const got = sink.digest;
      if (
        got === undefined ||
        got.sha256 !== want.digest.sha256 ||
        got.bytes !== want.digest.bytes ||
        (want.rows !== undefined && got.lines !== want.rows)
      ) {
        throw fail(
          `${label} differs from the database` +
            (want.rows !== undefined
              ? ` (${got?.lines ?? 0} rows read, ${want.rows} in the database)`
              : ''),
        );
      }
      i++;
    }
    if (i !== expected.length) {
      throw fail(`it holds ${i} records, where ${expected.length} were written`);
    }
  } finally {
    reader.close();
  }
}

// ─── Read what travels with the rows ─────────────────────────────────────────

/**
 * The archive's manifest and state files, read without touching any database:
 * what a home with no config needs before it can start a cluster to restore
 * into (its database password is in the archive's config).
 */
export async function readBackupStateFiles(
  archive: string,
  opts: { passphrase?: string } = {},
): Promise<{ manifest: BackupManifest; texts: Map<string, string>; encrypted: boolean }> {
  const reader = await BackupReader.open(archive, opts);
  try {
    const first = await reader.next();
    if (first?.kind !== 'manifest') {
      throw new BackupError('BACKUP_DAMAGED', `${archive}: it does not start with its manifest.`);
    }
    const texts = new Map<string, string>();
    for (;;) {
      const header = await reader.next();
      if (header?.kind !== 'state-file') break;
      texts.set(header.name, (await reader.payloadBytes()).bytes.toString('utf-8'));
    }
    return { manifest: first.manifest, texts, encrypted: reader.header.encryption !== null };
  } finally {
    reader.close();
  }
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export interface RestoreBackupOptions extends Pick<RunMigrationsOptions, 'migrationsFolder'> {
  readonly archive: string;
  readonly passphrase?: string;
  /** True when the target cluster has pgvector (the migrations keep `vector` columns). */
  readonly vector: boolean;
  /** This home's state files: the live key becomes the archive's, the replaced one is kept. */
  readonly stateFiles: SnapshotStateFiles;
  /** Where the archive's workspaces go, a folder that must not exist yet; omitted, they are not extracted. */
  readonly workspacesInto?: string;
  readonly programVersion: string;
  /** How many copies the migration that follows keeps (`snapshots.keep`). */
  readonly keep: number;
  /** Free bytes where the cluster writes, for the copy before that migration. */
  readonly freeBytes: () => number | Promise<number>;
  readonly now?: () => Date;
  readonly onStep?: (text: string) => void;
}

export interface RestoreBackupResult {
  readonly manifest: BackupManifest;
  readonly encrypted: boolean;
  /** The copy the archive was loaded into, now the database. */
  readonly restored: Snapshot;
  /** The copy the replaced database became (with its key and config beside it). */
  readonly replaced: Snapshot;
  /** Live state files the swap made the archive's (the master key). */
  readonly putBack: readonly PutBackFile[];
  /** The archive's state files, by name (the caller decides what to do with the config). */
  readonly texts: ReadonlyMap<string, string>;
  readonly tables: number;
  readonly rows: number;
  readonly workspaceFiles: number;
  /** What the normal migration path then did to the restored database. */
  readonly migrated: MigrateDatabaseResult;
  /** The stored secret that decrypted with the restored key; null when none is stored. */
  readonly proof: string | null;
}

/**
 * Bring the archive back as the database named by `connectionString`. The
 * database it replaces is kept as a copy. Throws `BackupError` before anything
 * is replaced when the archive is unusable, newer than this program, damaged,
 * or carries a key that does not open its secrets.
 */
export async function restoreBackup(
  connectionString: string,
  opts: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  const now = opts.now ?? ((): Date => new Date());
  const reader = await BackupReader.open(
    opts.archive,
    opts.passphrase === undefined ? {} : { passphrase: opts.passphrase },
  );
  let scratch: { name: string; url: string } | null = null;
  let workspacesMade = false;
  let manifest: BackupManifest;
  const texts = new Map<string, string>();
  let restored: Snapshot;
  let tables = 0;
  let rows = 0;
  let workspaceFiles = 0;
  try {
    const first = await reader.next();
    if (first?.kind !== 'manifest') {
      throw new BackupError(
        'BACKUP_DAMAGED',
        `${opts.archive}: it does not start with its manifest.`,
      );
    }
    manifest = first.manifest;

    // 1. A schema this program can rebuild.
    // The same rule as a start (schema-state.ts): only a migration LATER than
    // this program's newest one makes the archive newer. An older row no
    // journal claims is restored with the rest of the history.
    const journal = readProgramJournal(opts);
    const ahead = schemaStateOf(
      journal,
      manifest.schema.history.map((w) => Number(w)),
    ).ahead;
    if (ahead.length > 0) {
      throw new BackupError(
        'BACKUP_NEWER_THAN_PROGRAM',
        `${opts.archive} was made by version ${manifest.madeBy}, its schema up to ` +
          `${manifest.schema.lastMigration ?? '(unknown)'}; this program (${opts.programVersion}) ` +
          `knows migrations up to ${journal.at(-1)?.tag ?? '(none)'}, and ${ahead.length} of the ` +
          `archive's are not among them. Install version ${manifest.madeBy} or newer to restore ` +
          'it. Nothing was changed.',
      );
    }
    if (manifest.schema.history.length === 0) {
      throw new BackupError('BACKUP_DAMAGED', `${opts.archive}: its manifest names no schema.`);
    }

    // 2. An empty copy, the archive's schema built in it by the normal path.
    opts.onStep?.('Building the schema of the backup…');
    scratch = await createEmptySnapshot(connectionString, {
      at: now(),
      lastMigration: manifest.schema.lastMigration,
    });
    const target = scratch;
    if (opts.vector) {
      await withSql(target.url, (sql) => sql`CREATE EXTENSION IF NOT EXISTS vector`);
    }
    const subset = migrationsFolderFor(manifest.schema.history, opts);
    try {
      await migrateDatabase(target.url, {
        migrationsFolder: subset,
        patchVectorAsText: !opts.vector,
        repair: false,
        programVersion: opts.programVersion,
        keep: 1,
        // An empty database: no copy is taken of it.
        freeBytes: () => Number.MAX_SAFE_INTEGER,
        stateFiles: { dir: opts.stateFiles.dir, files: [] },
      });
    } finally {
      rmSync(subset, { recursive: true, force: true });
    }

    // The rows, in one transaction.
    opts.onStep?.('Loading the rows…');
    const sql = connect(target.url);
    try {
      await sql.begin(async (tx) => {
        for (const s of SESSION) await tx.unsafe(s);
        try {
          await tx.unsafe('SET LOCAL session_replication_role = replica');
        } catch (err) {
          throw new BackupError(
            'BACKUP_NOT_PERMITTED',
            `the database user may not load rows with triggers off (${reasonOf(err)}); a ` +
              'restore needs a superuser. Nothing was replaced.',
            { cause: err },
          );
        }
        const shapes = new Map((await tableShapes(tx)).map((t) => [key(t.schema, t.table), t]));
        if (shapes.size > 0) {
          await tx.unsafe(
            `TRUNCATE ${[...shapes.values()].map((t) => qualified(t.schema, t.table)).join(', ')}`,
          );
        }
        const loaded = new Map<string, number>();
        for (;;) {
          const header = await reader.next();
          if (header === null) break;
          switch (header.kind) {
            case 'manifest':
              throw new BackupError('BACKUP_DAMAGED', `${opts.archive}: a second manifest.`);
            case 'state-file': {
              const text = (await reader.payloadBytes()).bytes.toString('utf-8');
              const file = opts.stateFiles.files.find((f) => f.name === header.name);
              if (file !== undefined) {
                try {
                  file.spec.parse(text);
                } catch (err) {
                  throw new BackupError(
                    'BACKUP_DAMAGED',
                    `${opts.archive}: its ${header.name} is not valid (${reasonOf(err)}). Nothing was replaced.`,
                  );
                }
              }
              texts.set(header.name, text);
              break;
            }
            case 'table': {
              const k = key(header.schema, header.table);
              const shape = shapes.get(k);
              const theirs = [...header.columns].sort().join(', ');
              const ours = shape === undefined ? '' : [...shape.columns].sort().join(', ');
              if (shape === undefined || theirs !== ours) {
                throw new BackupError(
                  'BACKUP_SCHEMA_MISMATCH',
                  shape === undefined
                    ? `${opts.archive} holds table ${k}, which the schema it names does not ` +
                        'create. Nothing was replaced.'
                    : `${opts.archive}: table ${k} has the columns (${theirs}) where its schema ` +
                        `has (${ours}). Nothing was replaced.`,
                );
              }
              const sink: { digest?: BackupRecordDigest } = {};
              const writable = await tx
                .unsafe(
                  `COPY ${qualified(header.schema, header.table)} ` +
                    `(${header.columns.map(ident).join(', ')}) FROM STDIN`,
                )
                .writable();
              await pipeline(reader.payload(sink), writable);
              loaded.set(k, sink.digest?.lines ?? 0);
              tables++;
              rows += sink.digest?.lines ?? 0;
              break;
            }
            case 'sequences': {
              const seqs = JSON.parse(
                (await reader.payloadBytes()).bytes.toString('utf-8'),
              ) as BackupSequence[];
              const present = new Set((await sequenceNames(tx)).map((s) => key(s.schema, s.name)));
              for (const s of seqs) {
                if (!present.has(key(s.schema, s.name))) {
                  throw new BackupError(
                    'BACKUP_SCHEMA_MISMATCH',
                    `${opts.archive} holds sequence ${key(s.schema, s.name)}, which its schema ` +
                      'does not create. Nothing was replaced.',
                  );
                }
                await tx.unsafe('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [
                  qualified(s.schema, s.name),
                  s.lastValue,
                  s.isCalled,
                ]);
              }
              break;
            }
            case 'workspace-dir':
            case 'workspace-file': {
              if (opts.workspacesInto === undefined) break; // read past by next()
              if (!workspacesMade) {
                mkdirSync(opts.workspacesInto, { recursive: false });
                workspacesMade = true;
              }
              const full = insideFolder(opts.workspacesInto, header.path, opts.archive);
              if (header.kind === 'workspace-dir') {
                mkdirSync(full, { recursive: true });
              } else {
                await pipeline(
                  reader.payload(),
                  createWriteStream(full, { flags: 'wx', flush: true }),
                );
                workspaceFiles++;
              }
              break;
            }
            case 'end':
              break;
          }
        }
        // Every table of the schema must have come back, with as many rows as it left with.
        for (const [k, t] of shapes) {
          const expectedRows = loaded.get(k);
          if (expectedRows === undefined) {
            throw new BackupError(
              'BACKUP_SCHEMA_MISMATCH',
              `${opts.archive} holds no rows record for table ${k}. Nothing was replaced.`,
            );
          }
          const [count] = await tx.unsafe<{ n: string }[]>(
            `SELECT count(*)::text AS n FROM ONLY ${qualified(t.schema, t.table)}`,
          );
          if (Number(count?.n ?? -1) !== expectedRows) {
            throw new BackupError(
              'BACKUP_FAILED',
              `table ${k}: ${count?.n ?? '?'} rows loaded, ${expectedRows} in the archive. ` +
                'Nothing was replaced.',
            );
          }
        }
      });
    } finally {
      await sql.end();
    }
    if (opts.workspacesInto !== undefined && manifest.workspaces && !workspacesMade) {
      mkdirSync(opts.workspacesInto, { recursive: false });
      workspacesMade = true;
    }

    // 3. The archive's key must open what it restored, before anything is replaced.
    opts.onStep?.('Checking the master key of the backup…');
    const keyFile = masterKeyEntry(opts.stateFiles);
    const keyText = keyFile === undefined ? undefined : texts.get(keyFile.name);
    {
      const { db, close } = createClient(target.url, { max: 1 });
      try {
        const verdict = await checkMasterKey(
          db,
          keyText === undefined ? null : MASTER_KEY_FILE.parse(keyText),
        );
        if (!verdict.opens) {
          throw new BackupError(
            verdict.reason === 'missing' ? 'BACKUP_KEY_MISSING' : 'BACKUP_KEY_DOES_NOT_OPEN',
            verdict.reason === 'missing'
              ? `${opts.archive} holds ${verdict.what} encrypted with a master key, and no master ` +
                  'key. Its secrets could not be read. Nothing was replaced.'
              : `the master key in ${opts.archive} does not open its secrets (${verdict.what} ` +
                  'does not decrypt with it). Nothing was replaced.',
          );
        }
      } finally {
        await close();
      }
    }

    restored = await completeSnapshot(connectionString, target.name, {
      at: now(),
      kind: 'from-backup',
      lastMigration: manifest.schema.lastMigration,
      lastOpenedBy: manifest.madeBy,
      madeBy: opts.programVersion,
      stateFiles: opts.stateFiles,
      texts,
    });
  } catch (err) {
    reader.close();
    if (scratch !== null) {
      await dropSnapshot(connectionString, scratch.name, opts.stateFiles.dir).catch(
        () => undefined,
      );
    }
    if (workspacesMade && opts.workspacesInto !== undefined) {
      rmSync(opts.workspacesInto, { recursive: true, force: true });
    }
    if (err instanceof BackupError) throw err;
    if (sqlStateOf(err) === '42501') {
      throw new BackupError('BACKUP_NOT_PERMITTED', `${reasonOf(err)}. Nothing was replaced.`, {
        cause: err,
      });
    }
    throw new BackupError('BACKUP_FAILED', `${reasonOf(err)}. Nothing was replaced.`, {
      cause: err,
    });
  }
  reader.close();

  // 4. The swap: the current database is kept as a copy, the key travels.
  opts.onStep?.('Swapping the restored database in…');
  const current = await readSchemaState(connectionString, opts);
  const openedBy = await readOpenedBy(connectionString);
  const recorded = openedBy !== null && openedBy !== 'unreadable' ? openedBy : null;
  const swap = await restoreSnapshot(connectionString, restored.name, {
    at: now(),
    madeBy: opts.programVersion,
    stateFiles: opts.stateFiles,
    currentLastMigration: current.lastApplied?.tag ?? recorded?.lastMigration ?? null,
    currentOpenedBy: recorded?.version ?? null,
    replacedKind: 'replaced-by-restore',
  });

  // 5. The normal path to this program's schema, then the proof. Its prune
  // never drops the copy this restore just set aside and named.
  const migrated = await migrateDatabase(connectionString, {
    patchVectorAsText: !opts.vector,
    repair: false,
    programVersion: opts.programVersion,
    keep: opts.keep,
    protect: [swap.replaced.name],
    freeBytes: opts.freeBytes,
    stateFiles: opts.stateFiles,
    now,
    ...(opts.migrationsFolder !== undefined ? { migrationsFolder: opts.migrationsFolder } : {}),
    ...(opts.onStep !== undefined ? { onStep: opts.onStep } : {}),
  });
  let proof: string | null;
  {
    const keyFile = masterKeyEntry(opts.stateFiles);
    const { db, close } = createClient(connectionString, { max: 1 });
    try {
      if (keyFile !== undefined) await assertMasterKeyRestorable(db, { keyPath: keyFile.path });
      const verdict = await checkMasterKey(
        db,
        keyFile === undefined ? null : readMasterKeyFile(keyFile.path),
      );
      if (!verdict.opens) {
        throw new BackupError(
          'BACKUP_KEY_DOES_NOT_OPEN',
          `after the swap, ${verdict.what} does not decrypt with the live master key. The ` +
            `database it replaced is kept as ${swap.replaced.name}.`,
        );
      }
      proof = verdict.proof;
    } finally {
      await close();
    }
  }

  return {
    manifest,
    encrypted: reader.header.encryption !== null,
    restored: swap.restored,
    replaced: swap.replaced,
    putBack: swap.putBack,
    texts,
    tables,
    rows,
    workspaceFiles,
    migrated,
    proof,
  };
}

async function withSql<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = connect(url);
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}
