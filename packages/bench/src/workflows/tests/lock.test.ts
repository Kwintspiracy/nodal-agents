// lock.test.ts — un seul banc à la fois sur une stack.
//
// Revue Codex de la PR #634, constat 1 : au démarrage, le banc annulait comme
// « orphelins » TOUS les essais du banc encore vivants. Un banc lancé à la main
// pendant le banc de nuit tuait donc l'essai vivant de l'autre processus. Ces
// cas jouent le vrai verrou (un vrai fichier, de vrais PID) : ce qu'ils
// vérifient, c'est qui tient le verrou, le message du refus et les arbres
// réellement annulés.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireBenchLock, BenchStop, claimStack, isProcessAlive, stopOwnTrials } from '../lock';

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), 'wf-lock-')), 'workflows.lock');

/** Le PID d'un processus qui a existé et qui est terminé. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  if (typeof r.pid !== 'number') throw new Error('could not spawn a short-lived process');
  return r.pid;
}

function holdBy(path: string, pid: number): void {
  writeFileSync(
    path,
    JSON.stringify({
      pid,
      startedAt: '2026-09-30T03:00:00.000Z',
      argv: 'bench:workflows --scheduled',
      token: 'the-other-bench',
    }),
  );
}

const ROOTS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', entityId: 'e1' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', entityId: 'e1' },
];

describe('one bench per stack', () => {
  it('reads a process as alive or finished, on this system', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  it('a second bench refuses to start while the first one is alive, and says who holds the lock', () => {
    const path = lockPath();
    const first = acquireBenchLock(path, { pid: process.pid });
    expect(() => acquireBenchLock(path, { pid: process.pid + 1 })).toThrow(
      new RegExp(
        `^workflow_bench_busy: another workflow bench is running on this stack \\(pid ${process.pid}, started `,
      ),
    );
    // Le refus ne touche pas au verrou du premier.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    first.release();
    expect(existsSync(path)).toBe(false);
  });

  it('a lock left by a bench that died is taken over, and says so', () => {
    const path = lockPath();
    const dead = deadPid();
    holdBy(path, dead);
    const said: string[] = [];
    const lock = acquireBenchLock(path, { pid: process.pid, log: (l) => said.push(l) });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    expect(said).toEqual([
      `took over the bench lock left by a process that is gone (pid ${dead}, started 2026-09-30T03:00:00.000Z)`,
    ]);
    lock.release();
  });

  it('releasing never removes a lock another bench holds', () => {
    const path = lockPath();
    const mine = acquireBenchLock(path, { pid: process.pid });
    holdBy(path, process.pid); // un autre jeton : le verrou n'est plus le mien
    mine.release();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ token: 'the-other-bench' });
  });

  it('an unreadable lock is refused loudly, never taken over by guess', () => {
    const path = lockPath();
    writeFileSync(path, '');
    expect(() => acquireBenchLock(path, { pid: process.pid })).toThrow(
      /^workflow_bench_lock_unreadable: /,
    );
  });
});

describe('claiming the stack before cleaning up', () => {
  it('while another bench holds the lock, its live trials are NOT cancelled', async () => {
    const path = lockPath();
    holdBy(path, process.pid); // l'autre banc : un processus vivant
    const cancelled: string[] = [];
    await expect(
      claimStack({
        lockPath: path,
        pid: process.pid + 1,
        liveRoots: async () => ROOTS,
        cancel: async (r) => {
          cancelled.push(r.id);
        },
        log: () => undefined,
      }),
    ).rejects.toThrow(/^workflow_bench_busy: /);
    expect(cancelled).toEqual([]);
  });

  it('once the lock is ours, a trial still alive is an orphan of a dead bench: it is cancelled', async () => {
    const path = lockPath();
    holdBy(path, deadPid());
    const cancelled: string[] = [];
    const said: string[] = [];
    const lock = await claimStack({
      lockPath: path,
      pid: process.pid,
      liveRoots: async () => ROOTS,
      cancel: async (r) => {
        cancelled.push(r.id);
      },
      log: (l) => said.push(l),
    });
    expect(cancelled).toEqual(ROOTS.map((r) => r.id));
    expect(said.slice(1)).toEqual(
      ROOTS.map((r) => `cancelled a run left alive by an earlier bench: ${r.id}`),
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    lock.release();
  });

  it('a cleanup that fails releases the lock and says why', async () => {
    const path = lockPath();
    await expect(
      claimStack({
        lockPath: path,
        pid: process.pid,
        liveRoots: async () => ROOTS,
        cancel: async () => {
          throw new Error('connection refused');
        },
        log: () => undefined,
      }),
    ).rejects.toThrow('connection refused');
    expect(existsSync(path)).toBe(false);
  });
});

// Passe 2 (Nodal Reviewer A), P2 : juste après le lancement, le banc ne
// connaît pas encore l'espace du job (`run_task` ne rend que son id). Un
// Ctrl+C dans cette fenêtre relâchait le verrou et sortait sans rien annuler.
// À l'arrêt, le banc annule donc TOUS les essais du banc vivants, lus en base
// avec leur espace : il tient le verrou, ils ne peuvent être qu'à lui.
describe('stopping the bench', () => {
  it('a trial just started, whose workspace the bench does not know yet, is cancelled on Ctrl+C', async () => {
    const path = lockPath();
    const lock = acquireBenchLock(path, { pid: process.pid });
    // Ce que la base dit du job que run_task vient de créer.
    const justStarted = { id: 'cccccccc-0000-4000-8000-000000000003', entityId: 'e1' };
    const cancelled: Array<{ id: string; entityId: string }> = [];
    await stopOwnTrials(lock, {
      liveRoots: async () => [justStarted],
      cancel: async (r) => {
        cancelled.push(r);
      },
      log: () => undefined,
    });
    expect(cancelled).toEqual([justStarted]);
    lock.release();
  });

  it('a bench stopped before it holds the lock cancels nothing: the live trials belong to another bench', async () => {
    const cancelled: string[] = [];
    await stopOwnTrials(null, {
      liveRoots: async () => ROOTS,
      cancel: async (r) => {
        cancelled.push(r.id);
      },
      log: () => undefined,
    });
    expect(cancelled).toEqual([]);
  });
});

// Passe 3 (Reviewer A) : l'arrêt balayait UNE fois puis sortait. Un run_task en
// vol, ou lancé juste après le balayage (fin d'un essai, attente, préparation du
// suivant), laissait son job vivant. L'arrêt pose donc un drapeau partagé :
// plus aucun lancement, le lancement en vol est attendu (borné), et le balayage
// vient APRÈS.
describe('stopping while a trial is being started', () => {
  const JOB = { id: 'dddddddd-0000-4000-8000-000000000004', entityId: 'e1' };

  /** La base du faux monde : le job n'y existe qu'une fois run_task revenu. */
  function world() {
    const live: Array<{ id: string; entityId: string }> = [];
    const cancelled: string[] = [];
    let finish: () => void = () => undefined;
    const startCalled: string[] = [];
    const runTask = () => {
      startCalled.push('run_task');
      return new Promise<{ jobId: string }>((resolve) => {
        finish = () => {
          live.push(JOB);
          resolve({ jobId: JOB.id });
        };
      });
    };
    const sweep = {
      liveRoots: async () => [...live],
      cancel: async (r: { id: string }) => {
        cancelled.push(r.id);
      },
      log: () => undefined,
    };
    return { live, cancelled, startCalled, runTask, sweep, finish: () => finish() };
  }

  it('a run_task in flight when the stop comes is awaited, then its job is cancelled', async () => {
    const lock = acquireBenchLock(lockPath(), { pid: process.pid });
    const w = world();
    const stop = new BenchStop();
    const started = stop.start(w.runTask);
    const stopping = stop.stop(lock, w.sweep, { waitMs: 5_000 });
    // run_task revient APRÈS la demande d'arrêt : le job naît à ce moment-là.
    setTimeout(() => w.finish(), 20);
    await stopping;
    await started;
    expect(w.cancelled).toEqual([JOB.id]);
    lock.release();
  });

  it('once stopping, no new trial is started', async () => {
    const lock = acquireBenchLock(lockPath(), { pid: process.pid });
    const w = world();
    const stop = new BenchStop();
    await stop.stop(lock, w.sweep, { waitMs: 5_000 });
    await expect(stop.start(w.runTask)).rejects.toThrow(/^workflow_stopped: /);
    expect(w.startCalled).toEqual([]);
    expect(stop.stopped).toBe(true);
    lock.release();
  });

  it('a run_task that never returns does not hold the stop forever: it says so and still sweeps', async () => {
    const lock = acquireBenchLock(lockPath(), { pid: process.pid });
    const w = world();
    w.live.push({ id: 'eeeeeeee-0000-4000-8000-000000000005', entityId: 'e1' });
    const said: string[] = [];
    const stop = new BenchStop();
    void stop.start(w.runTask);
    await stop.stop(lock, { ...w.sweep, log: (l) => said.push(l) }, { waitMs: 30 });
    expect(said[0]).toBe(
      'a run_task call was still in flight after 30 ms; if it created a job, the next bench cancels it before it starts',
    );
    expect(w.cancelled).toEqual(['eeeeeeee-0000-4000-8000-000000000005']);
    lock.release();
  });
});
