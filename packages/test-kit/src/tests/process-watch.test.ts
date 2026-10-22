// process-watch.test.ts — la mort d'un processus lue sur le processus tenu,
// jamais sur un pid redonné (#834), sur de VRAIS processus.
//
// Ce qu'il faut prouver : vivant tant qu'il tourne, mort dès qu'il meurt ; et,
// sous Windows, que le pid d'un processus mort n'est redonné à PERSONNE tant
// que la veille le tient. Sans veille, Windows le redonne : mesuré le 22/10
// (Windows 11 26200), au bout d'environ 240 créations de processus.
//
// Mutation vérifiée (annulée ensuite) : `watchProcess` qui ferme son handle
// aussitôt ouvert (une veille qui ne tient rien) → « a watched pid is given to
// no other process » rouge, le pid revient sous un inconnu.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { watchProcess } from '../process-watch';

/** Un processus qui dort, le temps qu'on le surveille. */
function sleeper(): Promise<number> {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    c.once('spawn', () => resolve(c.pid as number));
    c.once('error', reject);
  });
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
      process.kill(pid, 'SIGKILL');
      expect(await untilDead(() => watch.alive())).toBe(true);
    } finally {
      watch.release();
    }
  });

  it.runIf(process.platform === 'win32')(
    'a watched pid is given to no other process, and `process.kill(pid, 0)` reads its death too',
    async () => {
      const pid = await sleeper();
      const watch = await watchProcess(pid);
      try {
        process.kill(pid, 'SIGKILL');
        expect(await untilDead(() => watch.alive())).toBe(true);
        // De quoi faire revenir le pid sans veille : 2,5 fois l'écart mesuré.
        const given: number[] = [];
        for (let i = 0; i < 600; i++) {
          const c = spawn('cmd.exe', ['/d', '/c', 'exit'], { stdio: 'ignore', windowsHide: true });
          given.push(await new Promise<number>((r) => c.once('exit', () => r(c.pid as number))));
          if (given.at(-1) === pid) break;
        }
        expect(given).not.toContain(pid);
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        expect(watch.alive()).toBe(false);
      } finally {
        watch.release();
      }
    },
    60_000,
  );
});
