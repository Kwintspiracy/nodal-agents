// non-ascii-home.pg.test.ts — the embedded database starts from a Nodal home
// whose path holds accents and the shells' special characters, and a home its
// code page cannot hold is refused by name before anything is created (#1231).
//
// Until 2026-11-28, on Windows, a home with an accented letter never started:
// PostgreSQL read the `log_directory` it was given in the system's ANSI code
// page, opened "home A Ã©", and the postmaster exited with `FATAL: could not
// open log file`. With a letter outside that code page it was worse: initdb
// created the cluster in a best-fit spelling of the folder ("home O" for
// "home Ω") and reported success.
//
// The start below is the one `up` makes — `startEmbeddedPostgres` with every
// path left to its default, derived from NODALAI_HOME — so the data directory
// and the log directory are both under the home, as in an install.
//
// WHERE THIS PROVES WHAT. The start needs a machine that can start a cluster:
// a real Windows machine (where #1231 lives) and the Linux CI. GitHub's Windows
// runner cannot start one at all, in any folder (see
// embedded-postgres-available.ts): there the start case skips and says so.
// The refusal cases need no cluster — the refusal comes before any program
// starts — and run everywhere, the Windows CI included.

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
 * A space, the accent of #1231, and the characters each reader treats
 * specially: `'` (a GUC string's quote), `%` (cmd's variables, strftime's
 * escapes), `&`, `!`, `^` (cmd's operators), `(`. Every one is in every
 * western ANSI code page, and allowed in a Windows folder name.
 */
const HOME_NAME = "home A é 'q' 100% & !^ (x)";

const root = mkdtempSync(join(tmpdir(), 'nodal-home-names-'));
const home = join(root, HOME_NAME);
mkdirSync(home, { recursive: true });
// Before ANY import that reads it: `config.ts` derives every path from it at load.
process.env['NODALAI_HOME'] = home;

const { PG_DATA_DIR } = await import('../lib/config.ts');
const { postgresLogDirFor } = await import('../lib/pg-logging.ts');
const { readPostmasterClaim, resolvePgCtl, startEmbeddedPostgres } =
  await import('../lib/postgres.ts');
const { findFreePort } = await import('../lib/ports.ts');
const { PathNotReadableError, encodePathFor } = await import('../lib/path-handoff.ts');
const { postgresReaderFor, resolvePostgresPathReader, WINDOWS_CODE_PAGE_REMEDY } =
  await import('../lib/postgres-code-page.ts');

// Can this machine start a cluster AT ALL? Asked the way every real-cluster
// file of this package asks it, in a plain temporary folder (and said out loud
// when it cannot). Its cluster is stopped at once: this file needs the answer.
// A machine that starts the plain one and not ours is a red test, never a skip.
const { embeddedPostgres } = await import('./embedded-postgres-available.ts');
if (embeddedPostgres.handle) await embeddedPostgres.handle.stop();
rmSync(embeddedPostgres.root, { recursive: true, force: true });

/** The reader of THIS machine: its system ANSI code page on Windows, UTF-8 elsewhere. */
const machineReader = await resolvePostgresPathReader();
const homeFitsThisMachine = (() => {
  try {
    encodePathFor(machineReader, home);
    return true;
  } catch {
    return false;
  }
})();
if (!homeFitsThisMachine) {
  console.warn(
    `\n[tests] SKIPPING the start in "${HOME_NAME}": this machine's code page ` +
      `${machineReader.codePage} cannot hold it (its refusal is tested below).\n`,
  );
}

const PASSWORD = 'nodalai-home-names-test';
const port = await findFreePort(25540);
const pgCtl = await resolvePgCtl();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('the embedded database in a home named with an accent and shell characters @cap:installer-et-demarrer/moteur', () => {
  it('derives both of its folders from that home, as `up` does', () => {
    expect(PG_DATA_DIR).toBe(join(home, 'pg-data'));
    expect(postgresLogDirFor(PG_DATA_DIR).startsWith(join(home, 'logs', 'postgres'))).toBe(true);
  });

  it.skipIf(!embeddedPostgres.available || !homeFitsThisMachine)(
    'starts there, logs there, answers a query, and creates nothing anywhere else',
    async () => {
      const entry = registerTestCluster({ dataDir: PG_DATA_DIR, port, pgCtl });
      try {
        const handle = await withPostgresClusterStart('cli/non-ascii-home', () =>
          // Every path left to its default: exactly the start `up` makes.
          startEmbeddedPostgres(undefined, port, PASSWORD),
        );
        try {
          const { db, close } = createClient(handle.url, { max: 1 });
          try {
            const rows = (await db.execute(sql`select 40 + 2 as answer`)) as unknown as Array<{
              answer: number;
            }>;
            expect(Number(rows[0]?.answer)).toBe(42);
          } finally {
            await close();
          }
          // The lockfile the postmaster wrote names THIS data directory, in its
          // code page: read back the way it was written, it is ours, with the
          // pid of a live process (decoded as UTF-8 it was "foreign": null).
          const claimed = readPostmasterClaim(PG_DATA_DIR)?.pid ?? null;
          expect(claimed).not.toBeNull();
          expect(process.kill(claimed as number, 0)).toBe(true);
          expect(existsSync(join(PG_DATA_DIR, 'PG_VERSION'))).toBe(true);
          const logDir = postgresLogDirFor(PG_DATA_DIR);
          const logs = readdirSync(logDir).filter((n) => n.endsWith('.log'));
          expect(logs.length).toBeGreaterThan(0);
          const text = logs.map((n) => readFileSync(join(logDir, n), 'latin1')).join('');
          expect(text).toMatch(/database system is ready to accept connections/);
          // No other spelling of the home was created beside it.
          expect(readdirSync(root)).toEqual([HOME_NAME]);
        } finally {
          await handle.stop();
        }
      } finally {
        unregisterTestCluster(entry);
      }
    },
    180_000,
  );
});

describe('a home its code page cannot hold is refused before anything starts @cap:installer-et-demarrer/moteur', () => {
  // The western code page of #1231, given to the start as the machine's: the
  // refusal must come from the rule, on every system this test runs on.
  const westernPage = postgresReaderFor(1252);

  /** A fresh parent, so that "nothing else was created" is a fact about one folder. */
  function parentWith(name: string): { parent: string; dir: string } {
    const parent = mkdtempSync(join(root, 'refused-'));
    const dir = join(parent, name);
    mkdirSync(dir);
    return { parent, dir };
  }

  it('"home Ω": refused with the path, the character, the code page and the way out; no "home O" anywhere', async () => {
    const { parent, dir } = parentWith('home Ω');
    const dataDir = join(dir, 'pg-data');
    const attempt = startEmbeddedPostgres(dataDir, port, PASSWORD, join(dir, 'logs'), {
      pathReader: westernPage,
    });
    await expect(attempt).rejects.toBeInstanceOf(PathNotReadableError);
    await expect(attempt).rejects.toThrow(
      `PostgreSQL cannot be given the path "${dataDir}": it holds "Ω", which code page 1252 ` +
        `cannot carry. ${WINDOWS_CODE_PAGE_REMEDY}`,
    );
    // Nothing was created: not the cluster, not its log folder, and no
    // best-fit sibling of the home.
    expect(readdirSync(parent)).toEqual(['home Ω']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a log directory the page cannot hold: refused the same way, before the cluster exists', async () => {
    const { parent } = parentWith('plain');
    const dataDir = join(parent, 'plain', 'pg-data');
    const logDir = join(parent, 'logs 李');
    const attempt = startEmbeddedPostgres(dataDir, port, PASSWORD, logDir, {
      pathReader: westernPage,
    });
    await expect(attempt).rejects.toThrow(
      `PostgreSQL cannot be given the path "${logDir}": it holds "李"`,
    );
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(logDir)).toBe(false);
  });
});
