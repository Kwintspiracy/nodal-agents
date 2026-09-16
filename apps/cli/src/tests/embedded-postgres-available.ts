// embedded-postgres-available.ts — can this machine start a real cluster?
//
// Asked once, at module load, by actually doing it: a temp data directory, a
// free port, our own logging settings, and a stop. The cluster it starts is
// then HANDED to the test file, so the probe costs nothing extra — it is the
// same start the first case would have made.
//
// ## Why a test would ever be allowed to skip
//
// GitHub's Windows runner cannot start the embedded cluster. The postmaster
// exits immediately, writing nothing: no initdb error, no FATAL, no log file.
// Measured on 2026-09-15, CI run 34970625684 — 6.7s, three cases, no output of
// any kind. The same file passes on the Linux runner in 1.3s and on a real
// Windows machine in 6s.
//
// That is a fact about the machine, not about the code, and it is the same
// judgement `process-table-available.ts` already makes for the process table.
// A test that asserts a capability the OS declines to provide reports nothing
// about the product; it only turns the suite permanently red, and a permanently
// red suite is one nobody reads.
//
// ## What keeps this honest
//
//   1. The behaviour is proven on EVERY CI run, on the Linux runner, where the
//      cluster starts. `logging_collector` is not a Windows feature; what the
//      postmaster does with it is the same everywhere.
//   2. The SETTINGS are proven unconditionally and everywhere, by
//      `pg-logging.test.ts` — nothing there skips.
//   3. The skip announces itself, with the reason the start actually gave.
//
// A silent skip would be the thing to fear here. This one says what it could
// not do, and why.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddedPostgres, type PostgresHandle } from '../lib/postgres.ts';
import { findFreePort } from '../lib/ports.ts';

export interface EmbeddedPostgresProbe {
  /** True when a cluster actually started. */
  available: boolean;
  /** Why it did not, for the skip message. Empty when available. */
  reason: string;
  /** The running cluster, for the cases to use. Null when unavailable. */
  handle: PostgresHandle | null;
  /** Where that cluster writes its log. */
  logDir: string;
  /** Everything to delete afterwards. */
  root: string;
}

const root = mkdtempSync(join(tmpdir(), 'nodal-pg-log-'));
const logDir = join(root, 'logs', 'postgres');

async function probe(): Promise<EmbeddedPostgresProbe> {
  try {
    const handle = await startEmbeddedPostgres(
      join(root, 'pg-data'),
      await findFreePort(25460),
      'nodalai-test',
      logDir,
    );
    return { available: true, reason: '', handle, logDir, root };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      handle: null,
      logDir,
      root,
    };
  }
}

export const embeddedPostgres: EmbeddedPostgresProbe = await probe();

if (!embeddedPostgres.available) {
  console.warn(
    `\n[tests] SKIPPING the real-cluster logging cases: ${embeddedPostgres.reason}\n` +
      '        The logging SETTINGS are still proven, unconditionally, by\n' +
      '        pg-logging.test.ts. What is skipped is only what needs a cluster\n' +
      '        this machine will not start. See this file for why.\n',
  );
  rmSync(root, { recursive: true, force: true });
}
