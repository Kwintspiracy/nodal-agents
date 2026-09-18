// cluster-registry.test.ts — un cluster de test meurt avec son lanceur.
//
// Ce qui se prouve ici est la MÉCANIQUE : qui est arrêté, comment, et dans
// quel ordre de recours. Que le gestionnaire de sortie s'exécute vraiment est
// un fait sur Node, pas sur ce module, et il se vérifie en tuant un vrai run —
// ce que la section `## Verified` de la PR montre, chronomètre et table des
// processus à l'appui.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  postmasterPidOf,
  reapAbandonedTestClusters,
  registerTestCluster,
  registeredTestClusters,
  stopAllTestClustersSync,
  stopClusterSync,
  unregisterTestCluster,
  type ClusterRecord,
  type SyncStopDeps,
  type TestClusterEntry,
} from '../cluster-registry';

const roots: string[] = [];

function aDataDir(pidLine?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodal-registry-test-'));
  roots.push(dir);
  if (pidLine !== undefined) {
    writeFileSync(join(dir, 'postmaster.pid'), pidLine, 'utf-8');
  }
  return dir;
}

afterEach(() => {
  for (const entry of registeredTestClusters()) unregisterTestCluster(entry);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Des gestes ENREGISTRÉS : ce qui a été tenté, et ce que ça a rendu. */
function spyDeps(opts: { pgCtlWorks: boolean; killWorks?: boolean }): {
  deps: SyncStopDeps;
  pgCtlCalls: Array<[string, string]>;
  kills: number[];
} {
  const pgCtlCalls: Array<[string, string]> = [];
  const kills: number[] = [];
  return {
    pgCtlCalls,
    kills,
    deps: {
      postmasterPid: postmasterPidOf,
      runPgCtl: (pgCtl, dataDir) => {
        pgCtlCalls.push([pgCtl, dataDir]);
        return opts.pgCtlWorks;
      },
      killPostmaster: (pid) => {
        kills.push(pid);
        return opts.killWorks ?? true;
      },
    },
  };
}

describe('postmasterPidOf', () => {
  it('lit le pid de la PREMIÈRE ligne', () => {
    expect(postmasterPidOf(aDataDir('17654\nC:/data\n1789705990\n'))).toBe(17654);
  });

  it('rend null quand le fichier manque ou ne porte pas de pid', () => {
    expect(postmasterPidOf(aDataDir())).toBeNull();
    expect(postmasterPidOf(aDataDir('pas un pid\n'))).toBeNull();
    expect(postmasterPidOf(aDataDir('-3\n'))).toBeNull();
  });
});

describe('stopClusterSync — l’ordre des recours', () => {
  it('passe par pg_ctl quand il est là et qu’il aboutit', () => {
    const dataDir = aDataDir('4242\n');
    const spy = spyDeps({ pgCtlWorks: true });
    const entry: TestClusterEntry = { dataDir, port: 25999, pgCtl: 'C:/pg/bin/pg_ctl.exe' };

    expect(stopClusterSync(entry, spy.deps)).toBe('pg_ctl');
    expect(spy.pgCtlCalls).toEqual([['C:/pg/bin/pg_ctl.exe', dataDir]]);
    expect(spy.kills, 'un signal a été envoyé alors que pg_ctl avait abouti').toEqual([]);
  });

  it('tombe sur le SIGNAL quand pg_ctl n’aboutit pas', () => {
    const dataDir = aDataDir('4242\n');
    const spy = spyDeps({ pgCtlWorks: false });

    expect(stopClusterSync({ dataDir, port: 1, pgCtl: 'pg_ctl' }, spy.deps)).toBe('signal');
    expect(spy.kills).toEqual([4242]);
  });

  it('tombe sur le SIGNAL quand pg_ctl n’a pas pu être résolu', () => {
    const dataDir = aDataDir('99\n');
    const spy = spyDeps({ pgCtlWorks: true });

    expect(stopClusterSync({ dataDir, port: 1, pgCtl: null }, spy.deps)).toBe('signal');
    expect(spy.pgCtlCalls).toEqual([]);
    expect(spy.kills).toEqual([99]);
  });

  it('ne touche à RIEN quand le data dir ne réclame aucun postmaster', () => {
    const spy = spyDeps({ pgCtlWorks: true });

    expect(stopClusterSync({ dataDir: aDataDir(), port: 1, pgCtl: 'pg_ctl' }, spy.deps)).toBe(
      'nothing',
    );
    expect(spy.pgCtlCalls).toEqual([]);
    expect(spy.kills).toEqual([]);
  });

  it('rend « nothing » plutôt que d’arrêter, quand le signal lui-même échoue', () => {
    const spy = spyDeps({ pgCtlWorks: false, killWorks: false });

    expect(stopClusterSync({ dataDir: aDataDir('7\n'), port: 1, pgCtl: null }, spy.deps)).toBe(
      'nothing',
    );
    expect(spy.kills).toEqual([7]);
  });
});

describe('le registre', () => {
  it('arrête TOUT ce qui est inscrit, et se vide', () => {
    const first = registerTestCluster({ dataDir: aDataDir('11\n'), port: 1, pgCtl: null });
    const second = registerTestCluster({ dataDir: aDataDir('22\n'), port: 2, pgCtl: null });
    expect(registeredTestClusters()).toEqual([first, second]);

    const spy = spyDeps({ pgCtlWorks: false });
    expect(stopAllTestClustersSync(spy.deps)).toEqual(['signal', 'signal']);
    expect(spy.kills).toEqual([11, 22]);
    expect(registeredTestClusters()).toEqual([]);
  });

  it('n’arrête pas deux fois : un second passage ne signale plus rien', () => {
    registerTestCluster({ dataDir: aDataDir('11\n'), port: 1, pgCtl: null });
    const spy = spyDeps({ pgCtlWorks: false });
    stopAllTestClustersSync(spy.deps);
    expect(stopAllTestClustersSync(spy.deps)).toEqual([]);
    expect(spy.kills).toEqual([11]);
  });

  it('laisse tranquille un cluster que son propriétaire a retiré', () => {
    const entry = registerTestCluster({ dataDir: aDataDir('33\n'), port: 3, pgCtl: null });
    unregisterTestCluster(entry);

    const spy = spyDeps({ pgCtlWorks: false });
    expect(stopAllTestClustersSync(spy.deps)).toEqual([]);
    expect(spy.kills).toEqual([]);
  });
});

// ─── Le ramassage des runs TUÉS ──────────────────────────────────────────────
//
// Le cas que ni un `afterAll` ni un gestionnaire de sortie ne couvre : un
// `taskkill /F` sur le processus de test ne laisse tourner aucune ligne de
// JavaScript. Ce qui reste peut être ramassé par le RUN SUIVANT, et c'est ce
// que ces cas prouvent — y compris qu'il ne ramasse PAS le cluster d'un run
// encore vivant.

describe('reapAbandonedTestClusters', () => {
  /** Un dossier de fiches à nous, jamais celui de la machine. */
  function aRegistry(records: ClusterRecord[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-reap-test-'));
    roots.push(dir);
    records.forEach((record, i) => {
      writeFileSync(join(dir, `${record.ownerPid}-${i}.json`), JSON.stringify(record), 'utf-8');
    });
    return dir;
  }

  it('arrête le cluster d’un propriétaire MORT, et retire sa fiche', () => {
    const dataDir = aDataDir('4242\n');
    const dir = aRegistry([{ dataDir, port: 25999, pgCtl: null, ownerPid: 777 }]);
    const spy = spyDeps({ pgCtlWorks: false });

    const reaped = reapAbandonedTestClusters(spy.deps, dir, () => false);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.outcome).toBe('signal');
    expect(reaped[0]!.record.ownerPid).toBe(777);
    expect(spy.kills).toEqual([4242]);
    expect(readdirSync(dir), 'la fiche ramassée est restée').toEqual([]);
  });

  it('ne TOUCHE PAS au cluster d’un run encore vivant', () => {
    const dir = aRegistry([
      { dataDir: aDataDir('11\n'), port: 1, pgCtl: null, ownerPid: process.pid },
    ]);
    const spy = spyDeps({ pgCtlWorks: false });

    expect(reapAbandonedTestClusters(spy.deps, dir, () => true)).toEqual([]);
    expect(spy.kills, 'le cluster d’un run vivant a été arrêté').toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('laisse en place ce qu’il ne sait pas lire, plutôt que de le deviner', () => {
    const dir = aRegistry([]);
    writeFileSync(join(dir, 'cassée.json'), 'pas du json', 'utf-8');
    writeFileSync(join(dir, 'sans-pid.json'), JSON.stringify({ dataDir: 'x' }), 'utf-8');
    const spy = spyDeps({ pgCtlWorks: false });

    expect(reapAbandonedTestClusters(spy.deps, dir, () => false)).toEqual([]);
    expect(spy.kills).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('rend une liste vide quand il n’y a pas de dossier de fiches', () => {
    expect(
      reapAbandonedTestClusters(
        spyDeps({ pgCtlWorks: false }).deps,
        join(tmpdir(), 'nodal-absent'),
      ),
    ).toEqual([]);
  });
});
