// pg-logging.ts — make the embedded Postgres keep a log of its own.
//
// Until 2026-09-15 it kept none. Twice that day the runner logged `57P02:
// terminating connection because of crash of another server process`, the
// postmaster restarted every backend, the stack went down — and nothing on disk
// said WHICH backend died or WHY (issue #111). The embedded cluster ran with
// `log_destination = stderr` and no collector, and embedded-postgres hands that
// stderr to a callback the CLI keeps in memory for the duration of `start()`
// only. `pg-data/` had no `log/`, `~/.nodalai/logs/` had no postgres file, and
// the only trace of a crash was the runner's side of the disconnect.
//
// A postmaster that reaps a crashed child writes the pid AND the signal itself:
//
//   LOG:  server process (PID 12345) was terminated by signal 9: Killed
//   LOG:  terminating any other active server processes
//
// Those lines are all that separates "a backend was killed from outside" from
// "a backend segfaulted", and they are the whole reason this file exists. So
// the settings below are chosen to make sure they are WRITTEN and KEPT, not to
// make the log pretty.
//
// ## Why `log_min_messages = warning` does not drop them
//
// It reads like it would: those lines are LOG, not WARNING. It does not, and
// the reason is a quirk worth writing down rather than rediscovering. For
// `log_min_messages` the ranking is
//
//   DEBUG5 … DEBUG1 < INFO < NOTICE < WARNING < ERROR < LOG < FATAL < PANIC
//
// LOG sits ABOVE error, not below notice — that inversion exists precisely so
// that server-lifecycle messages survive a restrictive setting. `warning`
// therefore keeps WARNING, ERROR, LOG, FATAL and PANIC, which covers every line
// a crash produces, and drops the per-statement chatter that would bury them.
//
// ## Where the log goes, and why not into the data dir
//
// `~/.nodalai/logs/postgres/`, next to runner.log and web.log — the directory a
// human already opens when something broke, and the one `nodal-agents logs`
// knows. The default would be `pg-data/log/`, inside the directory whose
// ownership rules the rest of the CLI spends so much care on; a log is for
// reading after the cluster is gone, so it does not belong there.
//
// ## One subdirectory PER DATA DIRECTORY
//
// Not one shared directory (review pass 2 of #114). The file name is a DAY —
// `postgresql-2026-09-16.log` — and `log_truncate_on_rotation` empties that
// name when the day comes round again. Two clusters pointed at one directory
// therefore write into the same file and blank each other's history, which is
// the exact record #111 exists to keep: a `pnpm dev` stack and an isolated
// review worktree, side by side, is the ordinary case on this machine.
//
// The subdirectory is named after the data directory: its own name, so a human
// can tell the two apart, plus a short digest of the absolute path, because two
// different clusters can both be called `pg-data`.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LOG_DIR } from './config.ts';

/** The root all cluster logs live under. Absolute: Postgres never guesses. */
export const PG_LOG_DIR = join(LOG_DIR, 'postgres');

/**
 * Where THIS data directory's cluster writes its log.
 *
 * A directory of its own, because the file name is a day and
 * `log_truncate_on_rotation` empties a day name when it comes round: two
 * clusters sharing one directory would blank each other's crash history. See
 * the header.
 *
 * The name carries the data directory's own last segment so a human reading
 * `~/.nodalai/logs/postgres/` can tell which cluster is which, and a digest of
 * the absolute path because two clusters are very often both called `pg-data`.
 * The digest is taken over the path as `sameDirectory` in `postgres.ts` compares
 * it — resolved, forward slashes, case-folded on Windows only — so the same
 * directory spelled two ways lands in one place, and two directories that differ
 * only by case land in two places on a filesystem where that matters.
 */
export function postgresLogDirFor(dataDir: string): string {
  const normalised = normaliseDataDir(dataDir);
  const digest = createHash('sha256').update(normalised).digest('hex').slice(0, 8);
  const leaf = normalised.split('/').filter(Boolean).pop() ?? 'pg-data';
  return join(PG_LOG_DIR, `${leaf.replace(/[^A-Za-z0-9._-]/g, '_')}-${digest}`);
}

/** The same spelling rule `postgres.ts` uses to decide two paths are one. */
function normaliseDataDir(dataDir: string): string {
  const resolved = toPosixPath(resolve(dataDir)).replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * One log file per day, with a size backstop. Two settings, and they do NOT do
 * the same thing — the first wording here said "capped, truncated" as if they
 * did, which is wrong and worth being exact about (review pass 2 of #114):
 *
 *   · `log_rotation_age = 1d` gives a name a human can reason about ("what
 *     happened on the 15th"), and `log_truncate_on_rotation` applies TO THIS
 *     ONE: when a day name comes round again, the old file is emptied rather
 *     than appended to, so the names recycle instead of piling up forever.
 *   · `log_rotation_size` is a backstop against a single loud day filling a
 *     disk. Truncation does NOT apply to it: a size-triggered rotation on a
 *     name that has not changed does not overwrite the file, so a very loud day
 *     leaves more than one file behind. That is the intended trade — losing the
 *     rest of a crash-day's log to stay under a cap would defeat the point of
 *     keeping one at all.
 */
export const PG_LOG_ROTATION_SIZE_KB = 20 * 1024;

/**
 * The settings, as a plain map, so a test can read them without a Postgres.
 *
 * `logDirectory` is written with forward slashes: a GUC string is not a C
 * string — a backslash in `postgresql.conf` is taken literally on Windows and
 * usually works — but forward slashes are accepted on every platform and remove
 * the question entirely.
 */
export function toPosixPath(path: string): string {
  return path.split('\\').join('/');
}

export function postgresLoggingSettings(logDirectory: string): Record<string, string> {
  return {
    logging_collector: 'on',
    log_destination: 'stderr',
    log_directory: toPosixPath(logDirectory),
    log_filename: 'postgresql-%Y-%m-%d.log',
    log_rotation_age: '1d',
    log_rotation_size: `${PG_LOG_ROTATION_SIZE_KB}kB`,
    log_truncate_on_rotation: 'on',
    // See the header: this KEEPS the crash lines, it does not drop them.
    log_min_messages: 'warning',
    // %m = timestamp with milliseconds, %p = pid of the process writing the
    // line. Both are load-bearing for #111: attributing a crash means matching
    // a pid against what a process table said at a given instant.
    log_line_prefix: '%m [%p] %q%u@%d ',
    // A postmaster that reaps a crashed child names the signal only if it is
    // still around to write the line. On by default; said out loud because the
    // whole diagnosis depends on it.
    restart_after_crash: 'on',
  };
}

/** Keys this file owns. Anything else in the file is left exactly as it was. */
function managedKeys(): Set<string> {
  return new Set(Object.keys(postgresLoggingSettings('x')));
}

/** A GUC string literal: single-quoted, inner quotes doubled. */
export function quoteGuc(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Merge our settings into the text of a `postgresql.auto.conf`.
 *
 * Pure, and separate from the disk on purpose: the merge is the part that can
 * be wrong, and the part a test can hold still.
 *
 * `postgresql.auto.conf` is read LAST, so what lands here wins over
 * `postgresql.conf` — which is the point, since the embedded package writes the
 * latter. It is also the file `ALTER SYSTEM` rewrites: hence the merge rather
 * than an overwrite. Nothing in this product runs `ALTER SYSTEM`, but a user
 * with a psql prompt can, and silently discarding their setting would be the
 * kind of surprise this repository keeps apologising for.
 */
export function mergeAutoConf(existing: string, settings: Record<string, string>): string {
  const managed = managedKeys();
  const kept: string[] = [];
  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (managed.has(key)) continue;
    kept.push(trimmed);
  }
  const ours = Object.entries(settings).map(([k, v]) => `${k} = ${quoteGuc(v)}`);
  return (
    '# Do not edit this file manually!\n' +
    '# It will be overwritten by the ALTER SYSTEM command,\n' +
    '# and by nodal-agents for the logging_* settings (see apps/cli/src/lib/pg-logging.ts).\n' +
    [...kept, ...ours].join('\n') +
    '\n'
  );
}

/**
 * Write the logging settings into `<dataDir>/postgresql.auto.conf`, and make
 * sure the directory they point at exists.
 *
 * Called on EVERY start, not once at initdb: a data directory created by an
 * older version has none of this, and a user who cleared the file gets it back.
 *
 * Returns the directory the cluster will log into, so the caller can say where
 * to look. Throws nothing on a read failure of the existing file — an
 * unreadable auto.conf is replaced rather than allowed to stop a boot — but a
 * WRITE failure propagates: a start that silently keeps no log is exactly the
 * situation #111 is about.
 */
export function applyPostgresLoggingConfig(dataDir: string, logDirectory: string): string {
  mkdirSync(logDirectory, { recursive: true });
  const target = join(dataDir, 'postgresql.auto.conf');
  let existing = '';
  if (existsSync(target)) {
    try {
      existing = readFileSync(target, 'utf-8');
    } catch {
      existing = '';
    }
  }
  writeAtomically(target, mergeAutoConf(existing, postgresLoggingSettings(logDirectory)));
  return logDirectory;
}

/** The name of the scratch file `writeAtomically` uses, so a test can look for it. */
export function tempConfPath(target: string): string {
  return `${target}.nodalai.tmp`;
}

/**
 * Write a file whole, or not at all.
 *
 * `writeFileSync` truncates first and then writes: a crash, a full disk or a
 * killed process in between leaves a TRUNCATED `postgresql.auto.conf`, and a
 * Postgres that reads a half line refuses to start — this file is applied on
 * every start, so a failure here would lock the cluster out of every future
 * boot rather than just this one.
 *
 * The scratch file sits in the SAME directory as the target, because `rename`
 * is only atomic within a filesystem. The target is NOT unlinked first, on any
 * platform: `fs.renameSync` replaces an existing destination on Windows too
 * (MoveFileEx with MOVEFILE_REPLACE_EXISTING), and unlinking would open a
 * window where a failing rename leaves no config at all — which is how the
 * first shape of this fix was caught, by the third case in
 * `pg-logging-atomic.test.ts`.
 */
function writeAtomically(target: string, contents: string): void {
  const tmp = tempConfPath(target);
  writeFileSync(tmp, contents, 'utf-8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the scratch file is not worth a second failure */
    }
    throw err;
  }
}
