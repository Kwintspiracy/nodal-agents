// postgres-logging.pg.test.ts — a REAL embedded cluster, and the log it now
// keeps (issue #111).
//
// `pg-logging.test.ts` proves the settings we write, everywhere and without
// skipping. This proves that a postmaster READS them and acts on them, which is
// a different fact and the one that failed on 2026-09-15: the configuration was
// plausible, the log did not exist.
//
// The last case is the incident itself, reproduced: a backend killed from
// OUTSIDE. From inside the cluster that looks exactly like the `57P02` the
// runner logged twice that day — "terminating connection because of crash of
// another server process" — and the only thing that can tell it apart from a
// genuine segfault is the postmaster's own line naming the pid it reaped.
//
// The cluster is started by `embedded-postgres-available.ts`, which also
// decides whether this machine can run these cases at all, and says so out loud
// when it cannot. See that file for the whole of that argument.

import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, sql } from '@nodal-agents/db';
import { embeddedPostgres } from './embedded-postgres-available.ts';

const canStartCluster = embeddedPostgres.available;

// The budget is EXPLICIT because `apps/cli/vitest.config.ts` sets none, so
// vitest's 10s default applied here — and stopping a cluster means
// `pg_ctl stop -m fast`, which returns only once the postmaster has rolled back
// and detached its shared memory. It ran past 10s on the Linux runner and
// failed the whole file after every one of its cases had already passed.
//
// And the budget is now ENFORCED HERE rather than by the hook timing out, which
// is a different thing entirely. On the Linux runner, twice on 2026-09-16, that
// stop did not return at all: every case had passed, the third one had killed a
// backend from outside, and `pg_ctl stop -m fast` sat there while the postmaster
// went through the crash recovery that same case provoked. The hook then died
// anonymously at 120s — "Hook timed out" and not one word about which of its two
// lines hung.
//
// A teardown asserts nothing. Its job is to leave the machine clean and to SAY
// what it could not clean, so the next reader starts from a fact instead of a
// stopwatch. The temp directory is removed either way; on a runner that is the
// end of it, and on a developer's machine the printed line names the cluster
// that is still up.
const STOP_BUDGET_MS = 60_000;

afterAll(async () => {
  const handle = embeddedPostgres.handle;
  if (handle) {
    const began = Date.now();
    const stopped = await Promise.race([
      handle
        .stop()
        .then(() => true)
        .catch(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), STOP_BUDGET_MS)),
    ]);
    if (!stopped) {
      console.warn(
        `\n[tests] pg_ctl stop did not return within ${STOP_BUDGET_MS / 1000}s ` +
          `(waited ${Date.now() - began}ms). The data directory below is removed anyway;\n` +
          `        a postmaster may still be running against ${embeddedPostgres.root}.\n`,
      );
    }
  }
  rmSync(embeddedPostgres.root, { recursive: true, force: true });
}, 120_000);

/** Everything the cluster has written so far, all files concatenated. */
function logText(): string {
  let out = '';
  for (const name of readdirSync(embeddedPostgres.logDir)) {
    out += readFileSync(join(embeddedPostgres.logDir, name), 'utf-8');
  }
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
  it.skipIf(!canStartCluster)(
    'writes into a log directory of its own rather than nowhere',
    async () => {
      // The collector opens its first file at startup and writes the "database
      // system is ready" line into it. Before #111 this directory did not exist
      // at all — neither here nor under pg-data.
      expect(await until(() => logText().trim().length > 0, 30_000)).toBe(true);
      expect(logText()).toMatch(/database system is ready to accept connections/);
    },
    60_000,
  );

  it.skipIf(!canStartCluster)('stamps every line with a pid and a millisecond timestamp', () => {
    // `log_line_prefix = '%m [%p] …'`. Without the pid there is nothing to
    // match a process table against, which is the whole of the attribution
    // problem in #111.
    expect(logText()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[^[]*\[\d+\]/m);
  });

  it.skipIf(!canStartCluster)(
    'records the pid of a backend killed from outside, and how it died',
    async () => {
      // THE 2026-09-15 incident, reproduced. A backend is killed by the OS, the
      // postmaster reaps it and writes the line that says so. Until this PR the
      // runner's `57P02` was the only trace anywhere, and it names nothing.
      const handle = embeddedPostgres.handle;
      if (!handle) expect.fail('POSTGRES_NOT_STARTED — the probe reported a cluster and gave none');

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

      const named = await until(
        () => new RegExp(`\\(PID ${backendPid}\\)`).test(logText()),
        60_000,
      );
      expect(named).toBe(true);
      // And the postmaster's own account of the aftermath, which is the
      // sentence whose absence made the incident unattributable.
      expect(logText()).toMatch(/terminating any other active server processes/);
    },
    180_000,
  );
});
