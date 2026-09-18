// postgres-auth-stop.pg.test.ts — after the password is refused, nothing is
// left running.
//
// `postgres-auth-failure.test.ts` proves the DECISION against a fake handle:
// a SQLSTATE 28 error fails at the first refusal instead of being retried for
// 180s, and `stop` is called. Review pass 2 of #114 asked for the other half,
// and it is a fair ask — `stop` having been CALLED is not the same fact as no
// postmaster being left behind, and the two come apart the moment the package
// has nothing to signal yet.
//
// (It does. `embedded-postgres@18.3.0-beta.17` assigns `this.process = spawn(…)`
// synchronously inside `start()`, before the cluster accepts a single
// connection — dist/index.js, the `spawn(postgres, ['-D', …])` call. So there is
// always a process to stop by the time our probe loop runs. That was checked in
// the source rather than assumed, and this file checks the CONSEQUENCE against
// a real cluster instead of taking either of us at our word.)
//
// The shape: start a real cluster in a temp directory on a free port, stop it,
// then start it again with the WRONG password. The second start must fail with
// the SQLSTATE in the message, and the data directory must be left with no live
// postmaster.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerTestCluster,
  resolvePgCtlFrom,
  unregisterTestCluster,
  withPostgresClusterStart,
  type TestClusterEntry,
} from '@nodal-agents/test-kit';
import { startEmbeddedPostgres, livePostmasterPid } from '../lib/postgres.ts';
import { findFreePort } from '../lib/ports.ts';

const root = mkdtempSync(join(tmpdir(), 'nodal-pg-auth-'));
const dataDir = join(root, 'pg-data');
const logDir = join(root, 'logs');
const RIGHT = 'nodalai-right';
const WRONG = 'nodalai-wrong';

const port = await findFreePort(25480);
// Résolu UNE fois : le gestionnaire de sortie du registre est synchrone et ne
// peut pas faire cet `import()` au moment où il en a besoin.
const pgCtl = await resolvePgCtlFrom(join(process.cwd(), 'package.json'));

/**
 * Démarre un cluster SOUS LE VERROU DE LA MACHINE, et le tient inscrit tant
 * qu'il vit (issue #130).
 *
 * Deux défauts en un. Le verrou : `pnpm test` lance un `vitest run` par paquet
 * et trois d'entre eux démarrent de vrais clusters — le `fileParallelism:
 * false` de ce paquet ne voit rien des autres processus, et c'est bien depuis
 * les autres que venait la concurrence qui a fait dépasser les 120 s le 16/09.
 * Le registre : un run tué laissait des `postgres.exe` orphelins, parce que
 * sous Windows tuer un parent ne tue pas ses enfants et qu'aucun `afterAll` ne
 * s'exécute alors.
 *
 * `run` reçoit ce que `startEmbeddedPostgres` a rendu — ou rien, quand le
 * démarrage a échoué : c'est le cas du mot de passe refusé, où le produit
 * arrête lui-même le cluster qu'il a démarré.
 */
async function underClusterLock<T>(label: string, run: () => Promise<T>): Promise<T> {
  // Inscrit AVANT le verrou, et c'est sans effet de bord : tant qu'aucun
  // postmaster n'a écrit `postmaster.pid`, le gestionnaire de sortie ne trouve
  // rien à arrêter sur ce data dir. Ce qui compte est qu'il n'existe aucun
  // instant où un cluster tourne sans être inscrit.
  const entry: TestClusterEntry = registerTestCluster({ dataDir, port, pgCtl });
  try {
    return await withPostgresClusterStart(label, run);
  } finally {
    unregisterTestCluster(entry);
  }
}

/**
 * Can this machine start a cluster at all? Asked by doing it, then stopping it
 * — the same judgement `embedded-postgres-available.ts` makes, and for the same
 * reason: GitHub's Windows runner cannot, and a test that asserts a capability
 * the OS declines to provide reports nothing about the product.
 */
const setup = await (async (): Promise<{ ok: boolean; reason: string }> => {
  try {
    await underClusterLock('cli/postgres-auth-stop:probe', async () => {
      const handle = await startEmbeddedPostgres(dataDir, port, RIGHT, logDir);
      await handle.stop();
    });
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
})();

if (!setup.ok) {
  console.warn(
    `\n[tests] SKIPPING the wrong-password case: ${setup.reason}\n` +
      '        The decision itself is still proven, unconditionally, by\n' +
      '        postgres-auth-failure.test.ts.\n',
  );
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a refused password leaves nothing running @cap:installer-et-demarrer/moteur', () => {
  it.skipIf(!setup.ok)(
    'fails with the SQLSTATE and stops the cluster it started',
    async () => {
      // The cluster exists and its role has RIGHT. Starting it with WRONG makes
      // a postmaster come up, accept the TCP connection, and refuse the login —
      // which is exactly the case that used to wait 180 seconds and then report
      // a readiness timeout over a cluster nobody could stop any more.
      await expect(
        underClusterLock('cli/postgres-auth-stop:wrong', () =>
          startEmbeddedPostgres(dataDir, port, WRONG, logDir),
        ),
      ).rejects.toThrow(/authentication failed \(SQLSTATE 28/);

      // THE ASSERTION THIS FILE EXISTS FOR. `postmaster.pid` is written by the
      // postmaster that holds this directory and removed by a clean stop, so a
      // null here is the directory itself saying nothing of ours is alive on it.
      expect(livePostmasterPid(dataDir)).toBeNull();
    },
    120_000,
  );

  it.skipIf(!setup.ok)(
    'and the right password still works afterwards',
    async () => {
      // The stop was clean, not a kill: the very next start succeeds. A
      // teardown that left a shared-memory segment behind would fail here with
      // "pre-existing shared memory block is still in use".
      await underClusterLock('cli/postgres-auth-stop:right', async () => {
        const handle = await startEmbeddedPostgres(dataDir, port, RIGHT, logDir);
        await handle.stop();
      });
      expect(livePostmasterPid(dataDir)).toBeNull();
    },
    120_000,
  );
});
