// cluster-lock.test.ts — le verrou qui sérialise les démarrages de cluster.
//
// Ce qu'il faut prouver, et rien d'autre : qu'il EXCLUT réellement, qu'il ne
// vole jamais le verrou d'un processus vivant, et qu'il reprend celui d'un
// processus mort. Aucun Postgres n'est démarré ici — le verrou ne sait pas ce
// qu'il protège, et c'est ce qui le rend éprouvable en millisecondes.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOLDER_FILE,
  LOCK_STALE_AFTER_MS,
  LOCK_WAIT_BUDGET_MS,
  lockIsAbandoned,
  readHolder,
  withPostgresClusterStart,
  type LockHolder,
} from '../cluster-lock';

const roots: string[] = [];

/** Un dossier de verrou À NOUS, pour ne jamais toucher celui de la machine. */
function aLockDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'nodal-lock-test-'));
  roots.push(root);
  return join(root, 'lock');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Pose un verrou comme le ferait un autre processus. */
function forgeLock(lockDir: string, holder: Partial<LockHolder> & { pid: number }): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, HOLDER_FILE),
    JSON.stringify({ label: 'forged', at: Date.now(), ...holder }),
    'utf-8',
  );
}

/** Un pid dont on SAIT qu'il a disparu : celui d'un processus déjà terminé. */
function aDeadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.pid, 'aucun pid rendu par le processus témoin').toBeGreaterThan(0);
  return child.pid as number;
}

describe('lockIsAbandoned — la décision, sans système de fichiers', () => {
  const alive = (): boolean => true;
  const dead = (): boolean => false;

  it('un détenteur VIVANT garde son verrou, si vieux soit-il', () => {
    const holder: LockHolder = { pid: 42, label: 'x', at: 0 };
    expect(lockIsAbandoned({ holder, ageMs: LOCK_STALE_AFTER_MS * 100, isRunning: alive })).toBe(
      false,
    );
  });

  it('un détenteur DISPARU laisse un verrou abandonné, même tout neuf', () => {
    const holder: LockHolder = { pid: 42, label: 'x', at: Date.now() };
    expect(lockIsAbandoned({ holder, ageMs: 0, isRunning: dead })).toBe(true);
  });

  it('un verrou ILLISIBLE n’est abandonné qu’après le délai', () => {
    expect(lockIsAbandoned({ holder: null, ageMs: LOCK_STALE_AFTER_MS - 1, isRunning: dead })).toBe(
      false,
    );
    expect(lockIsAbandoned({ holder: null, ageMs: LOCK_STALE_AFTER_MS + 1, isRunning: dead })).toBe(
      true,
    );
  });
});

describe('readHolder', () => {
  it('rend ce qui a été écrit', () => {
    const lockDir = aLockDir();
    forgeLock(lockDir, { pid: 4242, label: 'runner' });
    expect(readHolder(lockDir)).toMatchObject({ pid: 4242, label: 'runner' });
  });

  it('rend null sur un fichier absent ou illisible', () => {
    const lockDir = aLockDir();
    expect(readHolder(lockDir)).toBeNull();
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, HOLDER_FILE), 'pas du json', 'utf-8');
    expect(readHolder(lockDir)).toBeNull();
    writeFileSync(join(lockDir, HOLDER_FILE), '{"pid":"nope"}', 'utf-8');
    expect(readHolder(lockDir)).toBeNull();
  });
});

describe('withPostgresClusterStart — l’exclusion', () => {
  it('deux démarrages concurrents ne se CHEVAUCHENT jamais', async () => {
    const lockDir = aLockDir();
    const trace: string[] = [];
    const section = (name: string) => async (): Promise<void> => {
      trace.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, 60));
      trace.push(`${name}:out`);
    };

    await Promise.all([
      withPostgresClusterStart('a', section('a'), lockDir),
      withPostgresClusterStart('b', section('b'), lockDir),
      withPostgresClusterStart('c', section('c'), lockDir),
    ]);

    // Le CONTENU de la trace, pas son ordre d'arrivée : chaque section ferme
    // avant que la suivante n'ouvre. Un chevauchement produirait `a:in b:in`.
    expect(trace).toHaveLength(6);
    for (let i = 0; i < trace.length; i += 2) {
      const [entered, left] = [trace[i]!, trace[i + 1]!];
      expect(left).toBe(entered.replace(':in', ':out'));
    }
  });

  it('rend le verrou même quand le démarrage ÉCHOUE', async () => {
    const lockDir = aLockDir();
    await expect(
      withPostgresClusterStart('boom', () => Promise.reject(new Error('initdb a lâché')), lockDir),
    ).rejects.toThrow('initdb a lâché');
    expect(existsSync(lockDir), 'le verrou est resté posé après un échec').toBe(false);

    // Et le suivant passe : c'est la conséquence qui compte.
    await expect(
      withPostgresClusterStart('après', () => Promise.resolve('ok'), lockDir),
    ).resolves.toBe('ok');
  });

  it('ATTEND un détenteur vivant, et repart dès qu’il a fini', async () => {
    const lockDir = aLockDir();
    // `process.pid` : un détenteur dont la vivacité n'est pas discutable. Ce
    // n'est pas nous au sens du verrou — rien n'a été pris par ce module.
    forgeLock(lockDir, { pid: process.pid, label: 'un autre processus' });

    let ran = false;
    const pending = withPostgresClusterStart(
      'en attente',
      async () => {
        ran = true;
        return 'fini';
      },
      lockDir,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(ran, 'le verrou d’un processus vivant a été volé').toBe(false);

    rmSync(lockDir, { recursive: true, force: true });
    await expect(pending).resolves.toBe('fini');
  });

  it('REPREND le verrou d’un processus mort, sans attendre', async () => {
    const lockDir = aLockDir();
    forgeLock(lockDir, { pid: aDeadPid(), label: 'un run tué' });

    const began = Date.now();
    await expect(
      withPostgresClusterStart('reprise', () => Promise.resolve('repris'), lockDir),
    ).resolves.toBe('repris');
    // Sans la reprise, l'appel aurait attendu tout le budget.
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it('RENONCE au verrou passé le budget, et démarre quand même', async () => {
    // Le cas qui a coûté trois fichiers rouges le 18/09 : un détenteur vivant
    // qui ne rend pas la main. Une exclusion stricte ferait tomber celui-ci
    // avec tous les suivants ; ici il démarre, et le dit.
    const lockDir = aLockDir();
    forgeLock(lockDir, { pid: process.pid, label: 'un démarrage qui traîne' });

    const began = Date.now();
    await expect(
      withPostgresClusterStart('malgré tout', () => Promise.resolve('démarré'), lockDir, 300),
    ).resolves.toBe('démarré');
    expect(Date.now() - began).toBeLessThan(5_000);
    // Le verrou de l'autre est intact : on ne le lui a pas pris.
    expect(readHolder(lockDir)).toMatchObject({ label: 'un démarrage qui traîne' });
  });

  it('le budget par défaut tient sous le budget d’un cas qui démarre un cluster', () => {
    // 120 s est le budget des deux cas de `postgres-auth-stop.pg.test.ts`.
    // Attendre plus que lui reviendrait à transformer l'attente en échec, ce
    // que l'issue #130 demande précisément d'éviter.
    expect(LOCK_WAIT_BUDGET_MS).toBeLessThan(120_000);
  });
});
