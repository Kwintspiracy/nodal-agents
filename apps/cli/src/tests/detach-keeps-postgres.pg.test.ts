// detach-keeps-postgres.pg.test.ts — `up --detach` leaves the database running
// (#835).
//
// `up --detach` reported "All services healthy", then the embedded Postgres died
// with the launcher while the runner and the web went on running against
// nothing. Two things killed it, and both are needed to keep it alive:
//   · `embedded-postgres` stops every cluster it started when the process exits;
//   · on Windows libuv puts a child into a job object that is killed with its
//     parent, unless the spawn is detached.
//
// REAL: a launcher process starts a real cluster the way `up` does and exits
// the way `up` exits; this file then looks at the cluster from the outside —
// the port, a query, the lockfile — and finally stops it with the real `down`.
// A temp NODALAI_HOME (never the owner's `~/.nodalai`), a free port well away
// from the owner's 25444, and whatever is left running is stopped in
// `afterAll` — through the watch opened on each postmaster while its launcher
// still lived, never by a pid read from the lockfile (#841).

import { afterAll, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-detach-pg-'));
  process.env['NODALAI_HOME'] = dir;
  return dir;
});

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  registerTestCluster,
  unregisterTestCluster,
  watchProcess,
  type ProcessWatch,
  withPostgresClusterStart,
} from '@nodal-agents/test-kit';
import { runDown } from '../commands/down.ts';
import { PG_DATA_DIR } from '../lib/config.ts';
import { importEmbeddedPostgres } from '../lib/embedded-postgres-module.ts';
import { findFreePort } from '../lib/ports.ts';
import { resolvePgCtl, stopOrphanPostgres, livePostmasterPid } from '../lib/postgres.ts';
import { processTable } from './process-table-available.ts';

const PASSWORD = 'detached-launcher-password-0123456789';
const cliDir = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/detached-launcher.fixture.ts', import.meta.url));
const port = await findFreePort(25900);
const pgCtl = await resolvePgCtl();

interface Launched {
  /** The postmaster pid the launcher printed, or null when it never got ready. */
  pid: number | null;
  /** That postmaster, held from the moment its pid was printed. */
  postmaster: ProcessWatch | null;
  exitCode: number | null;
  output: string;
}

/**
 * Run the launcher to its end. Its exit is tracked by the child handle's own
 * `exit` event — never by probing a pid, which Windows hands to the next
 * process that asks.
 */
async function launch(mode: 'detached' | 'foreground'): Promise<Launched> {
  const entry = registerTestCluster({ dataDir: PG_DATA_DIR, port, pgCtl });
  try {
    return await withPostgresClusterStart(`cli/detach-keeps-postgres:${mode}`, async () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fixture, PG_DATA_DIR, String(port), mode],
        { cwd: cliDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let output = '';
      // A launcher that died before READY has no stdin left to write GO to.
      child.stdin.on('error', () => undefined);
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
      });
      // The postmaster pid, read while the launcher waits for GO: the cluster
      // is alive then, in both modes, so the watch holds that postmaster.
      const printed = new Promise<number | null>((resolve) => {
        child.stdout.on('data', (b: Buffer) => {
          output += b.toString();
          const ready = /READY pid=(\d+)/.exec(output);
          if (ready) resolve(Number(ready[1]));
        });
        void exited.then(() => resolve(null));
      });
      child.stderr.on('data', (b: Buffer) => (output += b.toString()));
      const pid = await printed;
      const postmaster = pid === null ? null : await watchProcess(pid);
      if (postmaster !== null) held.push(postmaster);
      child.stdin.end('GO\n');
      const exitCode = await exited;
      return { pid, postmaster, exitCode, output };
    });
  } finally {
    unregisterTestCluster(entry);
  }
}

/** Does something accept a TCP connection on the cluster's port right now? */
function portAnswers(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (answers: boolean): void => {
      socket.destroy();
      resolve(answers);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2_000, () => done(false));
  });
}

async function waitUntil(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return check();
}

/** A real query against the cluster, through the package's own client. */
async function selectTwo(): Promise<number> {
  const EmbeddedPostgres = await importEmbeddedPostgres();
  const client = new EmbeddedPostgres({
    databaseDir: PG_DATA_DIR,
    user: 'nodalai',
    password: PASSWORD,
    port,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  }).getPgClient('nodalai');
  await client.connect();
  try {
    const result = await client.query('select 1 + 1 as two');
    return Number(result.rows[0]?.two);
  } finally {
    await client.end();
  }
}

/** Every postmaster a launcher of this file started, held since its READY. */
const held: ProcessWatch[] = [];

/**
 * A postmaster a case left running: stopped the way `down` stops an orphan,
 * then, as a last resort, killed through its watch. Never through a pid read
 * from the lockfile: once the cluster is down that number may name anyone.
 */
async function stopLeftover(postmaster: ProcessWatch | null): Promise<void> {
  if (postmaster === null || !postmaster.alive()) return;
  await stopOrphanPostgres(postmaster.pid, PG_DATA_DIR);
  if (await waitUntil(async () => !postmaster.alive(), 15_000)) return;
  postmaster.kill();
}

async function cleanUpLeftovers(): Promise<void> {
  for (const postmaster of held) await stopLeftover(postmaster);
}

afterAll(async () => {
  await cleanUpLeftovers();
  for (const postmaster of held.splice(0)) postmaster.release();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

// `down` needs a process table on Windows to prove the cluster is ours (see
// process-table-available.ts). Off Windows the single-pid proofs do not.
const canDown = process.platform !== 'win32' || processTable.available;

function skipUnlessStarted(launched: Launched, ctx: { skip: (why: string) => void }): void {
  if (launched.pid === null) {
    console.warn(`\n[tests] SKIPPING: this machine will not start a cluster: ${launched.output}\n`);
    ctx.skip('the cluster did not start here');
  }
}

describe('up --detach keeps the database running @cap:installer-et-demarrer/moteur', () => {
  it('the cluster answers a query after the launcher has exited', async (ctx) => {
    const launched = await launch('detached');
    skipUnlessStarted(launched, ctx);

    expect(launched.exitCode).toBe(0);
    // The launcher is gone (its exit event fired); the cluster is not.
    expect(await portAnswers()).toBe(true);
    expect(await selectTwo()).toBe(2);
    // And it is the very postmaster the launcher started.
    expect(livePostmasterPid(PG_DATA_DIR)).toBe(launched.pid);

    await stopLeftover(launched.postmaster);
  }, 180_000);

  it.skipIf(!canDown)(
    '`down` stops it afterwards, and the port is closed',
    async (ctx) => {
      const launched = await launch('detached');
      skipUnlessStarted(launched, ctx);
      expect(await portAnswers()).toBe(true);

      const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
      let result;
      try {
        result = await runDown();
      } finally {
        quiet.mockRestore();
      }

      expect(result.unstopped).toEqual([]);
      expect(await waitUntil(async () => !(await portAnswers()), 20_000)).toBe(true);
      expect(livePostmasterPid(PG_DATA_DIR)).toBeNull();
    },
    240_000,
  );
});

describe('a foreground launcher still takes the cluster with it @cap:installer-et-demarrer/moteur', () => {
  it('the port is closed once the launcher has exited', async (ctx) => {
    const launched = await launch('foreground');
    skipUnlessStarted(launched, ctx);

    expect(launched.exitCode).toBe(0);
    expect(await waitUntil(async () => !(await portAnswers()), 30_000)).toBe(true);

    await stopLeftover(launched.postmaster);
  }, 180_000);
});

// The cleanup of this file must reach only the postmasters it started (review
// pass 2 of #857). A pid read from the lockfile is a number: a foreground
// launcher takes the cluster down, the lockfile stays, and Windows hands the
// pid to the next process that asks, on CI another package's vitest worker.
describe('the cleanup of this file reaches only the postmasters it started (#841)', () => {
  it('a live stranger named by the lockfile survives the cleanup', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise<void>((resolve) => stranger.once('spawn', () => resolve()));
    mkdirSync(PG_DATA_DIR, { recursive: true });
    const lockfile = join(PG_DATA_DIR, 'postmaster.pid');
    const seconds = Math.floor(Date.now() / 1000);
    writeFileSync(lockfile, `${String(stranger.pid)}\n${PG_DATA_DIR}\n${String(seconds)}\n`);
    try {
      await cleanUpLeftovers();
      await new Promise((r) => setTimeout(r, 500));
      expect([stranger.exitCode, stranger.signalCode]).toEqual([null, null]);
    } finally {
      stranger.kill('SIGKILL');
      rmSync(lockfile, { force: true });
    }
  }, 120_000);
});
