// store-isolation.test.ts — aucun git qui lit l'arbre de travail n'a le droit
// d'écrire le magasin des checkpoints (#628, revue passe 5, P1).
//
// Un git qui lit l'ARBRE lit aussi la config des sous-dépôts du workspace, que
// le job écrit. Tout ce que cette config lui fait lancer tourne avec ses
// droits. La règle se vérifie donc sur ce que Nodal DEMANDE pour chaque
// lancement : le magasin (`<racine>/store`) n'est jamais une racine
// inscriptible, ni par lui-même ni par un dossier qui le contient. Que le bac à
// sable fasse respecter ces racines est prouvé à part, sur MXC
// (packages/sandbox/src/tests/deny-data-dir.test.ts).
//
// Les lancements sont enregistrés par un `CheckpointPrograms` qui exécute git
// sur l'hôte, comme le chemin par défaut : le test passe par les VRAIS gestes
// d'un instantané, d'un statut figé et d'une restauration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  snapshot,
  restoreCheckpoint,
  freezeSnapshotIndex,
  statusAgainstFrozenIndex,
  releaseFrozenIndex,
  type CheckpointPrograms,
  type CheckpointProgramOptions,
} from './checkpoints';

const run = promisify(execFile);

interface Launch {
  readonly args: readonly string[];
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
}

/** Git sur l'hôte, en notant les racines demandées à chaque lancement. */
function recordingPrograms(launches: Launch[]): CheckpointPrograms {
  const note = (
    args: readonly string[],
    o: Pick<CheckpointProgramOptions, 'writableRoots' | 'readableRoots'>,
  ): void => {
    launches.push({
      args: [...args],
      writableRoots: [...o.writableRoots],
      readableRoots: [...o.readableRoots],
    });
  };
  return {
    async execFile(file, args, opts) {
      note(args, opts);
      const r = await run(file, [...args], {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
        windowsHide: true,
        env: opts.env,
      });
      return { stdout: String(r.stdout), stderr: String(r.stderr) };
    },
    spawn(file, args, opts) {
      note(args, opts);
      return new Promise((ok, ko) => {
        const child = spawn(file, [...args], { windowsHide: true, env: opts.env });
        const closed = new Promise<{ code: number | null }>((r) =>
          child.on('close', (code) => r({ code })),
        );
        child.once('error', ko);
        child.once('spawn', () => {
          child.off('error', ko);
          child.on('error', () => undefined);
          ok({ stdout: child.stdout, stderr: child.stderr, kill: () => child.kill(), closed });
        });
      });
    },
  };
}

const norm = (p: string): string => {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** `root` est-il `target` lui-même, ou un dossier qui le contient ? */
function covers(root: string, target: string): boolean {
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

let root: string;
let store: string;
let ws: string;
let gitDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cp-iso-'));
  store = join(root, 'checkpoints');
  gitDir = join(store, 'store');
  ws = join(root, 'workspace');
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'a.txt'), 'one\n');
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

/** Les lancements qui lisent l'arbre de travail : ceux qu'on donne aux programmes. */
function assertStoreNeverWritable(launches: readonly Launch[]): void {
  // Le test n'est pas vide : des gits de l'arbre ont bien été lancés.
  expect(launches.length, 'no worktree git was launched through the programs').toBeGreaterThan(0);
  for (const l of launches) {
    const offending = l.writableRoots.filter((w) => covers(w, gitDir));
    expect(
      offending,
      `git ${l.args.join(' ')} could write the store through ${offending.join(', ')}`,
    ).toEqual([]);
  }
}

describe('checkpoint store isolation: a worktree-reading git never gets the store as a writable root (#628 pass 5) @cap:executer-une-commande/moteur', () => {
  it('snapshot: every worktree git runs with the store out of its writable roots', async () => {
    const launches: Launch[] = [];
    const cp = await snapshot(store, ws, 'iso', { programs: recordingPrograms(launches) });
    expect(cp).not.toBeNull();
    assertStoreNeverWritable(launches);
    // Il LIT le magasin (ses objets servent d'alternate) : déclaré en lecture.
    expect(launches.some((l) => l.readableRoots.some((r) => covers(r, gitDir)))).toBe(true);
  });

  it('frozen-index status: the worktree git runs with the store out of its writable roots', async () => {
    await snapshot(store, ws, 'first');
    await writeFile(join(ws, 'a.txt'), 'two\n');
    const frozen = await freezeSnapshotIndex(store, ws);
    expect(frozen.kind).toBe('frozen');
    if (frozen.kind !== 'frozen') return;
    const launches: Launch[] = [];
    try {
      await statusAgainstFrozenIndex(store, ws, frozen.indexFile, recordingPrograms(launches));
    } finally {
      await releaseFrozenIndex(frozen.indexFile);
    }
    assertStoreNeverWritable(launches);
  });

  it('restore: the safety snapshot and the checkout run with the store out of their writable roots', async () => {
    const first = await snapshot(store, ws, 'first');
    expect(first).not.toBeNull();
    await writeFile(join(ws, 'a.txt'), 'changed\n');
    const launches: Launch[] = [];
    await restoreCheckpoint(store, ws, first!.sha, recordingPrograms(launches));
    assertStoreNeverWritable(launches);
  });
});
