// process-watch.test.ts — la mort d'un processus lue sur le processus tenu,
// jamais sur un pid redonné (#834), sur de VRAIS processus.
//
// Ce qu'il faut prouver : vivant tant qu'il tourne, mort dès qu'il meurt ; et,
// sous Windows, que le pid d'un processus mort n'est redonné à PERSONNE tant
// que la veille le tient. Sans veille, Windows le redonne : mesuré le 22/10
// (Windows 11 26200), au bout d'environ 240 créations de processus.
//
// Ce test ne cherche PAS à voir le pid revenir en créant des centaines de
// processus (#901) : le retour d'un pid est affaire de chance (revu le 31/10 sur
// la même machine : 315 à plus de 1500 créations, ou jamais), donc une boucle
// bornée ne prouvait rien de façon fiable, et sa durée suivait la charge de la
// machine (60 s sur un runner chargé). Il lit la garantie dont la veille se sert :
// tant qu'un handle tient le processus, le noyau garde son objet, et le pid avec
// lui. Une ouverture indépendante réussit sur le processus mort si la veille le
// tient, échoue sinon. Même verdict à chaque exécution, quelle que soit la charge.
//
// Mutation vérifiée (annulée ensuite) : `watchProcess` qui ferme son handle
// aussitôt ouvert (une veille qui ne tient rien) → « a watched pid stays
// reserved » rouge, le pid n'est plus réservé.
// Mutation vérifiée (annulée ensuite) : `waitForDeath` qui rend `dead: true`
// sans lire la veille → « a process that does not die » rouge.

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import type * as KoffiModule from 'koffi';
import { survivalMessage, waitForDeath, watchProcess } from '../process-watch';

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Un processus qui dort, le temps qu'on le surveille. */
function sleeper(): Promise<number> {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    c.once('spawn', () => resolve(c.pid as number));
    c.once('error', reject);
  });
}

/** Un processus qui dort, avec sa fin à attendre. */
async function sleeperChild(): Promise<{
  child: ChildProcess;
  pid: number;
  exited: Promise<void>;
}> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  return { child, pid: child.pid as number, exited };
}

/** Attend (30 s au plus) que la sonde rende faux. */
async function untilFalse(probe: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 600 && (await probe()); i++) await new Promise((r) => setTimeout(r, 50));
  return !(await probe());
}

/** La sonde reste vraie pendant toute la durée (1 s) : rend faux dès qu'elle lâche. */
async function staysTrue(probe: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    if (!(await probe())) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Le pid désigne-t-il encore un objet processus du noyau ? Une ouverture
 * indépendante de la veille : elle réussit tant qu'un handle quelconque tient le
 * processus, mort ou vif, et échoue quand plus personne ne le tient (le pid est
 * alors libre d'être redonné). C'est la garantie même de Windows que la veille
 * exploite, lue directement, sans compter sur le hasard d'une réutilisation.
 */
let probe: Promise<(pid: number) => boolean> | undefined;

async function pidIsReserved(pid: number): Promise<boolean> {
  // Les types koffi ne s'enregistrent qu'une fois par processus.
  probe ??= (async () => {
    const imported = (await import('koffi')) as unknown as { default?: unknown };
    const koffi = (imported.default ?? imported) as typeof KoffiModule;
    const lib = koffi.load('kernel32.dll');
    koffi.pointer('PROBE_HANDLE', koffi.opaque());
    const open = lib.func(
      'PROBE_HANDLE __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)',
    );
    const close = lib.func('int __stdcall CloseHandle(PROBE_HANDLE h)');
    return (target: number): boolean => {
      const handle = open(PROCESS_QUERY_LIMITED_INFORMATION, 0, target);
      if (!handle) return false;
      close(handle);
      return true;
    };
  })();
  return (await probe)(pid);
}

async function untilDead(alive: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive();
}

describe('watchProcess: a test reads the death of the process it holds, never of a reused pid (#834)', () => {
  it('alive while it runs, dead once killed', async () => {
    const pid = await sleeper();
    const watch = await watchProcess(pid);
    try {
      expect(watch.alive()).toBe(true);
      expect(watch.kill('SIGKILL')).toBe(true);
      expect(await untilDead(() => watch.alive())).toBe(true);
    } finally {
      watch.release();
    }
  });

  it.runIf(process.platform === 'win32')(
    'a watched pid stays reserved by the system once its process is dead, so no other process can be given it',
    async () => {
      // Deux processus identiques morts ensemble, un seul tenu par une veille.
      // Le noyau libère un processus mort un instant après sa mort, et ce
      // délai suit la charge : le témoin NON tenu sert d'horloge. Quand son pid
      // est libre, celui de la veille, mort au même moment, ne tient plus que
      // par elle.
      const held = await sleeperChild();
      const witness = await sleeperChild();
      const watch = await watchProcess(held.pid);
      try {
        expect(watch.kill('SIGKILL')).toBe(true);
        witness.child.kill('SIGKILL');
        expect(await untilDead(() => watch.alive())).toBe(true);
        await Promise.all([held.exited, witness.exited]);
        expect(await untilFalse(() => pidIsReserved(witness.pid))).toBe(true);
        // Le noyau libère un processus mort avec un retard variable (0 à 40 ms
        // mesurés) : le pid tenu doit rester réservé bien au-delà, pas à un instant.
        expect(await staysTrue(() => pidIsReserved(held.pid))).toBe(true);
        expect(() => process.kill(held.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        expect(watch.alive()).toBe(false);
        // Et le tuer ne part vers personne (#841).
        expect(watch.kill('SIGKILL')).toBe(false);
      } finally {
        watch.release();
        witness.child.kill('SIGKILL');
      }
    },
    60_000,
  );
});

// #841 : le nettoyage d'un test du banc tuait par leur seul numéro des pid de
// lanceurs morts depuis vingt secondes ; sur la CI Windows, ces pid servaient
// déjà à d'autres paquets, workers vitest compris. `kill()` ne vise que le
// processus tenu, et seulement vivant.
describe('ProcessWatch.kill: a test kills the process it holds, never a pid (#841)', () => {
  it('a dead process is sent nothing, however many times it is asked', async () => {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: 'ignore' });
    const exited = new Promise<void>((r) => c.once('exit', () => r()));
    await new Promise<void>((r) => c.once('spawn', () => r()));
    const watch = await watchProcess(c.pid as number);
    try {
      await exited;
      expect(watch.alive()).toBe(false);
      expect(watch.kill()).toBe(false);
      expect(watch.kill('SIGKILL')).toBe(false);
    } finally {
      watch.release();
    }
  });

  it.runIf(process.platform === 'win32')(
    'a released watch refuses to kill: the pid it held is free again',
    async () => {
      const pid = await sleeper();
      const watch = await watchProcess(pid);
      watch.release();
      try {
        expect(() => watch.kill()).toThrow(/read after release/);
      } finally {
        const again = await watchProcess(pid);
        again.kill('SIGKILL');
        again.release();
      }
    },
  );
});

describe('waitForDeath: a bounded wait on the held process, which says how long it survived', () => {
  it('a process that does not die: not dead at the bound, and the message names who, since when and for how long', async () => {
    const pid = await sleeper();
    const watch = await watchProcess(pid);
    try {
      const wait = await waitForDeath(watch, 300);
      expect(wait.dead).toBe(false);
      expect(wait.waitedMs).toBeGreaterThanOrEqual(300);
      const message = survivalMessage(watch, wait, 'server', 'closeJobProcessScope');
      expect(message).toMatch(
        new RegExp(
          String.raw`^server \(pid ${String(pid)}\) held since \d\d:\d\d:\d\d\.\d{3} still alive \d+ ms after closeJobProcessScope$`,
        ),
      );
      expect(watch.openedAt).toBeLessThanOrEqual(Date.now());
    } finally {
      watch.kill('SIGKILL');
      watch.release();
    }
  });

  it('a process that dies during the wait: dead, well before the bound', async () => {
    const pid = await sleeper();
    const watch = await watchProcess(pid);
    try {
      setTimeout(() => watch.kill('SIGKILL'), 150);
      const started = Date.now();
      const wait = await waitForDeath(watch, 10_000);
      expect(wait.dead).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      watch.release();
    }
  });
});
