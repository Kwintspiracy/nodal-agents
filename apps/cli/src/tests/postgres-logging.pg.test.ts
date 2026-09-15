// postgres-logging.pg.test.ts — a REAL embedded cluster, and the log it now
// keeps (issue #111).
//
// `pg-logging.test.ts` proves the settings we write. This proves that a
// postmaster reads them and acts on them, which is a different fact and the one
// that failed on 2026-09-15: the configuration was plausible, the log did not
// exist.
//
// The second case is the incident itself, reproduced: a backend killed from
// OUTSIDE. From inside the cluster that looks exactly like the `57P02` the
// runner logged twice that day — "terminating connection because of crash of
// another server process" — and the only thing that can tell it apart from a
// genuine segfault is the postmaster's own line naming the pid it reaped.
//
// The start is a TEST, not a beforeAll: a beforeAll that throws marks the cases
// "skipped", and a silently skipped case is a false green (invariant #4). Same
// discipline as `real-postgres.pg.test.ts`.

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddedPostgres, type PostgresHandle } from '../lib/postgres.ts';
import { findFreePort } from '../lib/ports.ts';
import { createClient, sql } from '@nodal-agents/db';

const root = mkdtempSync(join(tmpdir(), 'nodal-pg-log-'));
const dataDir = join(root, 'pg-data');
const logDir = join(root, 'logs', 'postgres');

let pg: PostgresHandle | null = null;

afterAll(async () => {
  await pg?.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** Everything the cluster has written so far, all files concatenated. */
function logText(): string {
  let out = '';
  for (const name of readdirSync(logDir)) out += readFileSync(join(logDir, name), 'utf-8');
  return out;
}

/** Poll until `check` sees what it is waiting for, or give up. */
async function until(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      if (check()) return true;
    } catch {
      /* the directory may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe('the embedded cluster keeps its own log @cap:installer-et-demarrer/moteur', () => {
  it('starts, and writes into ~/.nodalai/logs/postgres rather than nowhere', async () => {
    pg = await startEmbeddedPostgres(dataDir, await findFreePort(25460), 'nodalai-test', logDir);
    // The collector opens its first file at startup and writes the "database
    // system is ready" line into it. Before #111 this directory did not exist
    // at all — neither here nor under pg-data.
    expect(await until(() => logText().trim().length > 0, 30_000)).toBe(true);
    expect(logText()).toMatch(/database system is ready to accept connections/);
  }, 180_000);

  it('stamps every line with a pid and a millisecond timestamp', () => {
    // `log_line_prefix = '%m [%p] …'`. Without the pid there is nothing to
    // match a process table against, which is the whole of the attribution
    // problem in #111.
    expect(logText()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[^[]*\[\d+\]/m);
  }, 30_000);

  it('records the pid of a backend killed from outside, and how it died', async () => {
    // THE 2026-09-15 incident, reproduced. A backend is killed by the OS, the
    // postmaster reaps it and writes the line that says so. Until this PR the
    // runner's `57P02` was the only trace anywhere, and it names nothing.
    const handle = pg;
    if (!handle) expect.fail('POSTGRES_NOT_STARTED — the start case failed before this one');

    // One connection, so the pid we read is the pid we then kill.
    const { db, close } = createClient(handle.url, { max: 1 });
    const rows = (await db.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{
      pid: number | string;
    }>;
    const backendPid = Number(rows[0]?.pid);
    expect(Number.isInteger(backendPid)).toBe(true);

    // SIGKILL is TerminateProcess on Windows — the same thing a stray
    // `taskkill /F` does, which is what issue #100 suspects happened here.
    try {
      process.kill(backendPid, 'SIGKILL');
    } catch {
      /* it may already be gone; the assertion below is the judge */
    }
    await close().catch(() => {});

    const named = await until(() => new RegExp(`\\(PID ${backendPid}\\)`).test(logText()), 60_000);
    expect(named).toBe(true);
    // And the postmaster's own account of the aftermath, which is the sentence
    // whose absence made the incident unattributable.
    expect(logText()).toMatch(/terminating any other active server processes/);
  }, 180_000);
});
