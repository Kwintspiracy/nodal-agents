// start-leaves-no-session.pg.test.ts — once the embedded cluster is started,
// nothing of ours is still connected to the database, so it can be copied.
//
// `up` copies the database before it migrates, and PostgreSQL copies a
// database only when no other session is connected to it. The start itself
// used to leave one: the pgvector probe kept its client open whenever the
// extension was missing, which is every start of a stock install (the
// embedded cluster ships no pgvector). Every migration would then have been
// refused. This proves the consequence on a real cluster: right after
// `startEmbeddedPostgres`, a copy of the database succeeds.
//
// The shape of postgres-auth-stop.pg.test.ts: a temp directory, a free port,
// the machine's cluster lock, and a skip only where the OS cannot start a
// cluster at all (GitHub's Windows runner, administrator account).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerTestCluster,
  unregisterTestCluster,
  withPostgresClusterStart,
  type TestClusterEntry,
} from '@nodal-agents/test-kit';
import { createSnapshot, listSnapshots } from '@nodal-agents/db/snapshots';
import { resolvePgCtl, startEmbeddedPostgres } from '../lib/postgres.ts';
import { buildDatabaseUrl } from '../lib/env.ts';
import { findFreePort } from '../lib/ports.ts';

const root = mkdtempSync(join(tmpdir(), 'nodal-pg-nosession-'));
const dataDir = join(root, 'pg-data');
const logDir = join(root, 'logs');
const PASSWORD = 'nodalai-no-session-test';
const port = await findFreePort(25520);
const pgCtl = await resolvePgCtl();

async function underClusterLock<T>(label: string, run: () => Promise<T>): Promise<T> {
  const entry: TestClusterEntry = registerTestCluster({ dataDir, port, pgCtl });
  try {
    return await withPostgresClusterStart(label, run);
  } finally {
    unregisterTestCluster(entry);
  }
}

const setup = await (async (): Promise<{ ok: boolean; reason: string }> => {
  try {
    await underClusterLock('cli/start-leaves-no-session:probe', async () => {
      const handle = await startEmbeddedPostgres(dataDir, port, PASSWORD, logDir);
      await handle.stop();
    });
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
})();

if (!setup.ok) {
  console.warn(`\n[tests] SKIPPING the copy-after-start case: ${setup.reason}\n`);
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the start leaves no session on the database @cap:installer-et-demarrer/moteur', () => {
  it.skipIf(!setup.ok)(
    'right after startEmbeddedPostgres, the database can be copied',
    async () => {
      await underClusterLock('cli/start-leaves-no-session:copy', async () => {
        const handle = await startEmbeddedPostgres(dataDir, port, PASSWORD, logDir);
        try {
          const url = buildDatabaseUrl(port, PASSWORD);
          const stateDir = join(root, 'snapshots');
          const snap = await createSnapshot(url, {
            at: new Date(),
            kind: 'before-migration',
            lastMigration: null,
            lastOpenedBy: null,
            madeBy: 'test',
            stateFiles: { dir: stateDir, files: [] },
            freeBytes: () => Number.MAX_SAFE_INTEGER,
          });
          expect((await listSnapshots(url, stateDir)).map((s) => s.name)).toEqual([snap.name]);
        } finally {
          await handle.stop();
        }
      });
    },
    120_000,
  );
});
