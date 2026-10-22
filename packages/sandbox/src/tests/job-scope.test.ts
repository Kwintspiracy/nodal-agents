// job-scope.test.ts — le périmètre d'un job : un conteneur par jeu de dossiers,
// réutilisé d'une commande à l'autre, fermé avec le job ; et, sous Windows, le
// vrai conteneur MXC qui meurt quand le runner meurt.

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobProcessScope, closeJobProcessScope, jobProcessScope } from '../job-scope';
import { createSandbox, getSandboxStatus } from '../status';
import type { CommandLaunch, JobContainer, SandboxBackend, StartedProcess } from '../types';

/** Un backend factice qui compte ses conteneurs et ce qu'on leur fait. */
function fakeBackend(): {
  backend: SandboxBackend;
  opened: { roots: readonly string[]; closed: boolean; alive: boolean }[];
} {
  const opened: { roots: readonly string[]; closed: boolean; alive: boolean }[] = [];
  const backend: SandboxBackend = {
    probe: async () => ({ state: 'available', backend: 'fake' }),
    openContainer: async (roots) => {
      const record = { roots, closed: false, alive: true };
      opened.push(record);
      const c: JobContainer = {
        get alive() {
          return record.alive && !record.closed;
        },
        start: async (_l: CommandLaunch): Promise<StartedProcess> => {
          throw new Error('not used');
        },
        close: async () => {
          record.closed = true;
        },
      };
      return c;
    },
  };
  return { backend, opened };
}

describe('JobProcessScope', () => {
  it('un conteneur par jeu de dossiers, réutilisé par les commandes suivantes du job', async () => {
    const { backend, opened } = fakeBackend();
    const scope = new JobProcessScope('j', createSandbox(backend, { log: () => {} }));
    const a = await scope.container(['C:\\ws'], {});
    const b = await scope.container(['C:\\ws'], {});
    const c = await scope.container(['C:\\other'], {});
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(opened.map((o) => o.roots)).toEqual([['C:\\ws'], ['C:\\other']]);
    await scope.close();
    expect(opened.map((o) => o.closed)).toEqual([true, true]);
  });

  it('un conteneur mort de lui-même est remplacé à la commande suivante', async () => {
    const { backend, opened } = fakeBackend();
    const scope = new JobProcessScope('j2', createSandbox(backend, { log: () => {} }));
    await scope.container(['C:\\ws'], {});
    opened[0]!.alive = false;
    await scope.container(['C:\\ws'], {});
    expect(opened).toHaveLength(2);
    await scope.close();
  });

  it('un périmètre fermé refuse de servir : JOB_SCOPE_CLOSED', async () => {
    const { backend } = fakeBackend();
    const scope = new JobProcessScope('j3', createSandbox(backend, { log: () => {} }));
    await scope.close();
    await expect(scope.container(['C:\\ws'], {})).rejects.toThrow('JOB_SCOPE_CLOSED: j3');
    await expect(
      scope.startOwned({ target: { command: 'exit 0' }, cwd: '.', env: {} }),
    ).rejects.toThrow('JOB_SCOPE_CLOSED: j3');
  });

  it('le registre : un job relancé après sa fermeture rouvre un périmètre neuf', async () => {
    const first = jobProcessScope('job-registry');
    expect(jobProcessScope('job-registry')).toBe(first);
    expect(await closeJobProcessScope('job-registry')).toBe(true);
    expect(await closeJobProcessScope('job-registry')).toBe(false);
    const second = jobProcessScope('job-registry');
    expect(second).not.toBe(first);
    expect(second.isClosed).toBe(false);
    await closeJobProcessScope('job-registry');
  });
});

// Le runner qui MEURT (tué, pas arrêté) : son courtier voit son entrée se
// fermer et tue ses conteneurs ; l'hôte, qui perd sa connexion, s'arrête aussi.
// Ce qu'un job laissait tourner ne survit pas.
const status = process.platform === 'win32' ? await getSandboxStatus() : undefined;
describe.runIf(status?.state === 'available')(
  'MXC — a runner killed outright takes its jobs’ processes with it (Windows only, MXC base-container tier)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'nodal-sbx-crash-'));
    // Le serveur tué peut tenir le dossier un instant encore (EPERM mesuré sur
    // windows-11-arm) : l'effacement réessaie, il ne masque pas un échec du test.
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

    it('the background server of a job dies when the process holding the job is killed', async () => {
      const here = fileURLToPath(new URL('.', import.meta.url));
      const tsx = resolve(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const info = join(dir, 'server.pid');
      writeFileSync(
        join(dir, 'server.cjs'),
        "require('http').createServer((q, s) => s.end('pong')).listen(0, '127.0.0.1', () => require('fs').writeFileSync(process.argv[2], String(process.pid)));\n",
      );
      const ready = join(dir, 'ready');
      writeFileSync(
        join(dir, 'fake-runner.mts'),
        [
          `import { jobProcessScope } from ${JSON.stringify(pathToFileURL(resolve(here, '..', 'index.ts')).href)};`,
          `import { writeFileSync } from 'node:fs';`,
          `const scope = jobProcessScope('crash-job');`,
          `const env = { ...process.env };`,
          `const c = await scope.container([${JSON.stringify(dir)}], env);`,
          `const p = await c.start({ target: { command: 'start "" /b "' + process.execPath + '" ' + ${JSON.stringify(join(dir, 'server.cjs'))} + ' ' + ${JSON.stringify(info)} }, cwd: ${JSON.stringify(dir)}, env });`,
          `p.stdout?.resume(); p.stderr?.resume(); await p.done;`,
          `writeFileSync(${JSON.stringify(ready)}, 'ok');`,
          `setInterval(() => {}, 1000);`,
        ].join('\n'),
      );
      const runner = spawn(process.execPath, [tsx, join(dir, 'fake-runner.mts')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let said = '';
      runner.stdout?.on('data', (d: Buffer) => (said += String(d)));
      runner.stderr?.on('data', (d: Buffer) => (said += String(d)));
      for (let i = 0; i < 400 && !(existsSync(ready) && existsSync(info)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(info), `the fake runner never started its server: ${said}`).toBe(true);
      const pid = Number(readFileSync(info, 'utf8'));
      const alive = (p: number): boolean => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(pid)).toBe(true);
      // Tué, pas arrêté : aucun code de fermeture ne tourne.
      spawn('taskkill', ['/PID', String(runner.pid), '/T', '/F'], { windowsHide: true });
      let dead = false;
      for (let i = 0; i < 100 && !dead; i++) {
        await new Promise((r) => setTimeout(r, 100));
        dead = !alive(pid);
      }
      if (!dead) process.kill(pid);
      expect(dead).toBe(true);
    }, 60_000);
  },
);
