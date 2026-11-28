// non-ascii-home.pg.test.ts — the embedded database starts from a Nodal home
// whose path holds any character a folder name may hold (#1231).
//
// Until 2026-11-28, on Windows, a home with an accented letter never started:
// PostgreSQL read the `log_directory` it was given in its ANSI code page, opened
// "home A Ã©", and the postmaster exited with `FATAL: could not open log file`.
// With a letter outside that code page it was worse: initdb created the cluster
// in a best-fit spelling of the folder ("home O" for "home Ω") and said nothing.
//
// The start below is the one `up` makes — `startEmbeddedPostgres` with every
// path left to its default, derived from NODALAI_HOME — so the data directory
// and the log directory are both under the home, as in an install. On Linux
// the same case proves that nothing in the chain mangles those bytes either.
//
// Skips only where the OS cannot start a cluster at all (GitHub's Windows
// runner, administrator account), and says so: see embedded-postgres-available.ts.

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerTestCluster,
  unregisterTestCluster,
  withPostgresClusterStart,
} from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';

/**
 * A space, an accented letter, Greek, Chinese, an emoji outside the Basic
 * Multilingual Plane, and the characters each reader treats specially: `'`
 * (a GUC string's quote), `%` (cmd's variables, strftime's escapes), `&`, `!`,
 * `^` (cmd's operators). Every one is allowed in a Windows folder name.
 */
const HOME_NAME = "home A é Ω 李 😀 'q' 100% & !^";

const root = mkdtempSync(join(tmpdir(), 'nodal-home-names-'));
const home = join(root, HOME_NAME);
mkdirSync(home, { recursive: true });
// Before ANY import that reads it: `config.ts` derives every path from it at load.
process.env['NODALAI_HOME'] = home;

const { PG_DATA_DIR } = await import('../lib/config.ts');
const { postgresLogDirFor } = await import('../lib/pg-logging.ts');
const { resolvePgCtl, startEmbeddedPostgres } = await import('../lib/postgres.ts');
const { findFreePort } = await import('../lib/ports.ts');
const { PathNotReadableError } = await import('../lib/path-handoff.ts');

const PASSWORD = 'nodalai-home-names-test';
const port = await findFreePort(25540);
const pgCtl = await resolvePgCtl();

/** PostgreSQL names Windows paths with forward slashes. */
function toSlashes(path: string): string {
  return path.split('\\').join('/');
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('the embedded database in a home named with any character @cap:installer-et-demarrer/moteur', () => {
  it('derives both of its folders from that home, as `up` does', () => {
    expect(PG_DATA_DIR).toBe(join(home, 'pg-data'));
    expect(postgresLogDirFor(PG_DATA_DIR).startsWith(join(home, 'logs', 'postgres'))).toBe(true);
  });

  it('starts there, logs there, answers a query, and creates nothing anywhere else', async () => {
    const entry = registerTestCluster({ dataDir: PG_DATA_DIR, port, pgCtl });
    try {
      const handle = await withPostgresClusterStart('cli/non-ascii-home', () =>
        // Every path left to its default: exactly the start `up` makes.
        startEmbeddedPostgres(undefined, port, PASSWORD),
      );
      try {
        const { db, close } = createClient(handle.url, { max: 1 });
        try {
          const rows = (await db.execute(
            sql`select current_setting('data_directory') as d`,
          )) as unknown as Array<{ d: string }>;
          // The server names the folder it runs in: the exact home, byte for byte.
          expect(toSlashes(String(rows[0]?.d))).toBe(toSlashes(PG_DATA_DIR));
        } finally {
          await close();
        }
        // The cluster is where it was asked to be…
        expect(existsSync(join(PG_DATA_DIR, 'PG_VERSION'))).toBe(true);
        // …its log file is in that home, and it is the server's own log…
        const logDir = postgresLogDirFor(PG_DATA_DIR);
        const logs = readdirSync(logDir).filter((n) => n.endsWith('.log'));
        expect(logs.length).toBeGreaterThan(0);
        const text = logs.map((n) => readFileSync(join(logDir, n), 'utf8')).join('');
        expect(text).toMatch(/database system is ready to accept connections/);
        // …and no best-fit spelling of the home was created beside it.
        expect(readdirSync(root)).toEqual([HOME_NAME]);
      } finally {
        await handle.stop();
      }
    } finally {
      unregisterTestCluster(entry);
    }
  }, 180_000);
});

describe('a PostgreSQL that cannot be given the path is refused by name @cap:installer-et-demarrer/moteur', () => {
  // A reader narrower than UTF-8: what a Windows without the UTF-8 code page
  // (older than 1903, or an install folder this user cannot write to) is.
  const asciiOnly = {
    program: 'PostgreSQL',
    encoding: 'ascii' as const,
    why: 'the test says so',
  };

  it('a data directory it cannot read: the path and the reason, and nothing created', async () => {
    const dataDir = join(root, 'refused Ω', 'pg-data');
    const logDir = join(root, 'ascii-logs');
    const attempt = startEmbeddedPostgres(dataDir, port, PASSWORD, logDir, {
      pathReader: asciiOnly,
    });
    await expect(attempt).rejects.toBeInstanceOf(PathNotReadableError);
    await expect(attempt).rejects.toThrow(
      `PostgreSQL cannot be given the path "${dataDir}": this program only reads ASCII ` +
        'paths here, and the path holds "Ω" (the test says so)',
    );
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(logDir)).toBe(false);
  });

  it('a log directory it cannot read: refused the same way, before the cluster exists', async () => {
    const dataDir = join(root, 'ascii-data', 'pg-data');
    const logDir = join(root, 'logs 李');
    const attempt = startEmbeddedPostgres(dataDir, port, PASSWORD, logDir, {
      pathReader: asciiOnly,
    });
    await expect(attempt).rejects.toThrow(`PostgreSQL cannot be given the path "${logDir}"`);
    expect(existsSync(dataDir)).toBe(false);
  });
});
