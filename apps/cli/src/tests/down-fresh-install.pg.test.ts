// down-fresh-install.pg.test.ts — a fresh start's three services, stopped by
// `down` (#767): Postgres (a REAL embedded cluster), and runner + web (stand-in
// processes recorded the way `up` records them, at the spawn).
//
// What identifies each one:
//   · Postgres — the data directory's own `postmaster.pid`, confirmed against a
//     fresh reading of the process table (`postgresProcessesForDataDir`);
//   · runner and web — the creation tick and executable name written by
//     `recordServiceTree` next to their pids.
// `down` must stop all three. The cluster lives under a temp NODALAI_HOME, never
// the owner's `~/.nodalai`, and is started under the machine-wide cluster lock.

import { afterAll, describe, expect, it, vi } from 'vitest';

const home = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodal-down-pg-'));
  fs.mkdirSync(path.join(dir, 'pids'), { recursive: true });
  process.env['NODALAI_HOME'] = dir;
  return dir;
});

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerTestCluster,
  unregisterTestCluster,
  withPostgresClusterStart,
  type TestClusterEntry,
} from '@nodal-agents/test-kit';
import { runDown } from '../commands/down.ts';
import { PG_DATA_DIR } from '../lib/config.ts';
import {
  livePostmasterPid,
  postgresProcessesForDataDir,
  resolvePgCtl,
  startEmbeddedPostgres,
} from '../lib/postgres.ts';
import { findFreePort } from '../lib/ports.ts';
import {
  isPidAlive,
  killPidTree,
  readPids,
  recordServiceTree,
  waitForPidDead,
} from '../lib/processes.ts';
import { processTable } from './process-table-available.ts';

const PASSWORD = 'nodalai-down-fresh-pw';
const port = await findFreePort(25520);
const pgCtl = await resolvePgCtl();
const logDir = join(home, 'logs');

async function underClusterLock<T>(label: string, run: () => Promise<T>): Promise<T> {
  const entry: TestClusterEntry = registerTestCluster({ dataDir: PG_DATA_DIR, port, pgCtl });
  try {
    return await withPostgresClusterStart(label, run);
  } finally {
    unregisterTestCluster(entry);
  }
}

// Windows needs a readable process table for `down` to confirm anything.
const tableOk = process.platform !== 'win32' || processTable.available;

let clusterStarted = false;
const setup = await (async (): Promise<{ ok: boolean; reason: string }> => {
  if (!tableOk) return { ok: false, reason: 'the process table cannot be read here' };
  try {
    await underClusterLock('cli/down-fresh-install:start', async () => {
      await startEmbeddedPostgres(PG_DATA_DIR, port, PASSWORD, logDir);
    });
    clusterStarted = true;
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
})();

if (!setup.ok) {
  console.warn(
    `\n[tests] SKIPPING the three-service down case: ${setup.reason}\n` +
      '        The runner/web half is proven without a cluster by down-fresh-record.test.ts.\n',
  );
}

const spawned: ChildProcess[] = [];

afterAll(async () => {
  for (const child of spawned.splice(0)) {
    if (child.pid && isPidAlive(child.pid)) await killPidTree(child.pid);
  }
  if (clusterStarted && livePostmasterPid(PG_DATA_DIR) !== null) {
    await runDown().catch(() => undefined);
  }
  rmSync(home, { recursive: true, force: true });
}, 120_000);

describe('down after a fresh start stops Postgres, runner and web @cap:installer-et-demarrer/moteur', () => {
  it.skipIf(!setup.ok)(
    'all three are dead afterwards, and the record is cleared',
    async () => {
      const spawnIdle = (): ChildProcess => {
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        spawned.push(child);
        return child;
      };
      const runner = spawnIdle();
      const web = spawnIdle();
      await recordServiceTree({ runner: runner.pid!, web: web.pid! });

      const pgPid = livePostmasterPid(PG_DATA_DIR);
      expect(pgPid, 'the cluster is up before down runs').not.toBeNull();
      // Postgres is identified by its data dir, confirmed by the table.
      if (process.platform === 'win32') {
        const reading = await postgresProcessesForDataDir();
        expect(reading.read).toBe(true);
        expect(reading.owned).toContain(pgPid);
      }

      const out = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runDown();
      } finally {
        out.mockRestore();
      }

      expect(await waitForPidDead(runner.pid!, 15_000)).toBe(true);
      expect(await waitForPidDead(web.pid!, 15_000)).toBe(true);
      expect(await waitForPidDead(pgPid!, 30_000)).toBe(true);
      expect(livePostmasterPid(PG_DATA_DIR)).toBeNull();
      expect(readPids()).toEqual({});
    },
    240_000,
  );
});
