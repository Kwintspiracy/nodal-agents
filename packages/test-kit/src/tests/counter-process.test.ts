// counter-process.test.ts — l'attente de la hausse d'un compteur (#834), sur
// un fichier que le test écrit lui-même et sur de VRAIS démons.
//
// Ce qu'il faut prouver : qu'un compteur arrêté plus longtemps que l'ancienne
// fenêtre fixe (400 ms), puis reparti, est vu monter ; qu'un démon mort fait
// échouer l'attente aussitôt, en disant s'il s'est planté ou s'il a été tué.
//
// Mutations vérifiées (chacune annulée ensuite) :
//   - `counterRise` réduit à une lecture après 400 ms (l'ancienne fenêtre) →
//     « a counter that pauses … » rouge ;
//   - le gestionnaire `uncaughtException` retiré de `COUNTER_DAEMON_SOURCE` →
//     « a daemon that crashes … » rouge (aucune trace, « killed from outside »).

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COUNTER_DAEMON_SOURCE, counterRise, crashRecordOf, readCounter } from '../counter-process';

const dir = mkdtempSync(join(tmpdir(), 'nodal-counter-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
const daemon = join(dir, 'daemon.cjs');
writeFileSync(daemon, COUNTER_DAEMON_SOURCE);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Un démon de comptage, prêt : son pid connu, son compteur écrit. */
async function startCounting(tag: string): Promise<{ pid: number; counter: string }> {
  const counter = join(dir, `${tag}.count`);
  const pidFile = join(dir, `${tag}.pid`);
  spawn(process.execPath, [daemon, counter, pidFile], { stdio: 'ignore' }).unref();
  for (let i = 0; i < 200 && !(existsSync(pidFile) && existsSync(counter)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { pid: Number(readFileSync(pidFile, 'utf8')), counter };
}

describe('counterRise: a bounded wait for a counting process, which says why it did not count (#834)', () => {
  it('a counter that pauses longer than the old fixed window (400 ms), then resumes, is seen rising', async () => {
    const counter = join(dir, 'paused.count');
    writeFileSync(counter, '1');
    // Le démon que l'ordonnanceur n'a pas servi pendant 900 ms.
    const resume = setTimeout(() => writeFileSync(counter, '2'), 900);
    try {
      const rise = await counterRise(counter, 1, { timeoutMs: 5_000 });
      expect(rise).toEqual({ value: 2, why: '' });
    } finally {
      clearTimeout(resume);
    }
  });

  it('a counter nobody writes fails the wait at its bound, and says so', async () => {
    const counter = join(dir, 'still.count');
    writeFileSync(counter, '3');
    const started = Date.now();
    const rise = await counterRise(counter, 3, { timeoutMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(rise.value).toBe(3);
    expect(rise.why).toMatch(/^the counter stayed at 3 for \d+ ms; its pid is unknown$/);
  });

  it('a live daemon counts: the wait ends at its first rise', async () => {
    const d = await startCounting('live');
    try {
      const floor = readCounter(d.counter);
      const rise = await counterRise(d.counter, floor, { pid: d.pid });
      expect(rise.why).toBe('');
      expect(rise.value).toBeGreaterThan(floor);
    } finally {
      process.kill(d.pid);
    }
  });

  it('a daemon killed from outside ends the wait at once: dead, no crash record', async () => {
    const d = await startCounting('killed');
    process.kill(d.pid, 'SIGKILL');
    for (let i = 0; i < 100 && alive(d.pid); i++) await new Promise((r) => setTimeout(r, 50));
    const floor = readCounter(d.counter);
    const started = Date.now();
    const rise = await counterRise(d.counter, floor, { pid: d.pid });
    // Mort, il ne comptera plus : l'attente ne va pas jusqu'à sa borne de 10 s.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rise.value).toBe(floor);
    expect(rise.why).toMatch(
      new RegExp(
        `^the counter stayed at ${String(floor)} for \\d+ ms; the daemon \\(pid ${String(d.pid)}\\) is dead and left no crash record: it was killed from outside$`,
      ),
    );
  });

  it('a daemon that crashes says so: its own error is quoted', async () => {
    const d = await startCounting('crashing');
    // Son écriture suivante est refusée (lecture seule) : l'exception le tue.
    chmodSync(d.counter, 0o444);
    try {
      for (let i = 0; i < 100 && alive(d.pid); i++) await new Promise((r) => setTimeout(r, 50));
      const floor = readCounter(d.counter);
      const rise = await counterRise(d.counter, floor, { pid: d.pid });
      expect(rise.value).toBe(floor);
      expect(rise.why).toContain(`the daemon (pid ${String(d.pid)}) crashed by itself: Error: E`);
      expect(readFileSync(crashRecordOf(d.counter), 'utf8')).toMatch(/^Error: E(PERM|ACCES)/);
    } finally {
      chmodSync(d.counter, 0o644);
      if (alive(d.pid)) process.kill(d.pid);
    }
  });
});
