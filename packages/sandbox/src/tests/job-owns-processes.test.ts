// job-owns-processes.test.ts — un job possède TOUT ce qu'il lance hors bac à
// sable, détachés compris (#750, #755), sur de VRAIS processus.
//
// Une commande lance un démon, puis sort. Le démon écrit un compteur toutes
// les 100 ms. Deux formes :
//   - dans le GROUPE de sa commande (sous Windows, détaché de l'arbre : un
//     enfant non détaché meurt avec le job Node de son parent) — chaque OS ;
//   - DÉTACHÉ de sa commande (`spawn({ detached: true })` : `setsid()` sous
//     Unix, il quitte le groupe) — là où le système sait le retrouver
//     (`detachedDescendantsReachable` : Windows par le Job Object, Linux par
//     l'étiquette ; pas macOS, limite dite dans unix-job-processes.ts). Ailleurs
//     le cas est SAUTÉ, raison au titre, jamais rouge.
// Ce qui se prouve :
//   - il VIT pour la commande suivante du même job (décision du 14/10), et il
//     travaille : son compteur monte. Attendu par `counterRise` (test-kit),
//     borné, et non sur une fenêtre fixe : celle de 400 ms a rougi une fois en
//     CI Windows sans dire si le démon était mort ou seulement pas servi ;
//     l'attente le dit ;
//   - il MEURT à la fermeture du périmètre (la fin du job), et le compteur
//     cesse de monter ;
//   - fermer le périmètre d'un job ne touche pas aux processus d'un autre ;
//   - un runner TUÉ ne laisse rien du job derrière lui une fois que le runner
//     qui reprend appelle `killLeftoversOfJob` (Windows : le noyau a déjà tué
//     les membres du Job Object ; Unix : l'étiquette du job les retrouve).
//
// Mutations vérifiées (chacune annulée ensuite) :
//   - `job.assign(child.pid)` retiré (host-container.ts) → sous Windows, le
//     démon survit à la fermeture : « dies when the scope closes » rouge ;
//   - `killLeftoversOfJob` retiré de `close()` (job-scope.ts) → sous Linux,
//     le démon `setsid` survit : même test rouge ;
//   - `close()` qui ne ferme plus le conteneur hors bac à sable → rouge sous
//     Windows.

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JobProcessScope, killLeftoversOfJob } from '../job-scope';
import { detachedDescendantsReachable } from '../unix-job-processes';
import {
  COUNTER_DAEMON_SOURCE,
  counterRise,
  readCounter,
  watchProcess,
  type ProcessWatch,
} from '@nodal-agents/test-kit';
import { createSandbox } from '../status';
import type { StartedProcess } from '../types';

const dir = mkdtempSync(join(tmpdir(), 'nodal-job-owns-'));

// Un processus tué peut tenir le dossier un instant encore (EPERM sous
// Windows) : l'effacement réessaie, il ne masque pas un échec du test.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

// Chaque pid lu est SURVEILLÉ aussitôt (test-kit process-watch.ts) : sous
// Windows, le pid d'un démon mort peut déjà servir à un inconnu, et
// `process.kill(pid, 0)` le dirait vivant. La veille tient le processus, et
// avec lui son pid, jusqu'à la fin du test.
const watches: ProcessWatch[] = [];
afterEach(() => {
  for (const w of watches.splice(0)) w.release();
});
async function watched(pid: number): Promise<ProcessWatch> {
  const w = await watchProcess(pid);
  watches.push(w);
  return w;
}

// Le démon : son pid, puis un compteur qui monte toutes les 100 ms
// (`daemon.cjs <compteur> <pid>`, test-kit counter-process.ts).
writeFileSync(join(dir, 'daemon.cjs'), COUNTER_DAEMON_SOURCE);
// La commande : lance le démon, sans tuyau commun, et SORT. argv[4] dit la
// forme : `detached` (sa propre session sous Unix) ou `group` (le groupe de la
// commande ; sous Windows, détaché de l'arbre, sinon il mourrait avec elle).
writeFileSync(
  join(dir, 'spawner.cjs'),
  [
    "const { spawn } = require('child_process');",
    "const detached = process.argv[4] === 'detached' || process.platform === 'win32';",
    "const c = spawn(process.execPath, [require('path').join(__dirname, 'daemon.cjs'), process.argv[3], process.argv[2]], { detached, stdio: 'ignore' });",
    'c.unref();',
  ].join('\n'),
);

type Shape = 'group' | 'detached';
const reachable = detachedDescendantsReachable();
/** Les formes que CE système sait tenir, et celle qu'il ne sait pas, dite. */
const SHAPES: [string, Shape, boolean][] = [
  ['in its command’s process group', 'group', true],
  [
    reachable
      ? 'detached from its command (own session)'
      : 'detached from its command (own session): SKIPPED, this platform cannot find a detached descendant (macOS: no /proc, stated limit)',
    'detached',
    reachable,
  ],
];
// La commande suivante : le démon répond-il encore ?
writeFileSync(
  join(dir, 'probe.cjs'),
  [
    "const pid = Number(require('fs').readFileSync(process.argv[2], 'utf8'));",
    "try { process.kill(pid, 0); console.log('alive ' + pid); } catch { console.log('dead ' + pid); }",
  ].join('\n'),
);

/** Un bac à sable indisponible : tout passe par `startOwned`, comme sur une machine sans MXC. */
const unconfined = () => createSandbox(null, { platform: 'linux', log: () => {} });

const env = (): Record<string, string | undefined> => ({ ...process.env });

async function run(proc: StartedProcess): Promise<string> {
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += String(d)));
  proc.stderr?.resume();
  await proc.done;
  return out;
}

async function startDaemon(
  scope: JobProcessScope,
  tag: string,
  shape: Shape = 'detached',
): Promise<{ pid: number; counter: string; watch: ProcessWatch }> {
  const pidFile = join(dir, `${tag}.pid`);
  const counter = join(dir, `${tag}.count`);
  const end = await scope
    .startOwned({
      target: {
        file: process.execPath,
        args: [join(dir, 'spawner.cjs'), pidFile, counter, shape],
      },
      cwd: dir,
      env: env(),
    })
    .then((p) => {
      p.stdout?.resume();
      p.stderr?.resume();
      return p.done;
    });
  expect(end).toEqual({ kind: 'exit', exitCode: 0 });
  for (let i = 0; i < 200 && !(existsSync(pidFile) && existsSync(counter)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const pid = readCounter(pidFile);
  return { pid, counter, watch: await watched(pid) };
}

async function deadWithin(watch: ProcessWatch, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!watch.alive()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !watch.alive();
}

describe.each(SHAPES)(
  'a job owns what a command leaves running, %s (#750, #755) @cap:executer-une-commande/moteur',
  (_label, shape, enabled) => {
    it.runIf(enabled)(
      'a grandchild whose parent exited lives for the next command, then dies when the scope closes',
      async () => {
        const scope = new JobProcessScope(`owns-${randomUUID()}`, unconfined());
        const { pid, counter, watch } = await startDaemon(scope, `one-${shape}`, shape);
        try {
          // Sa commande est sortie ; lui vit, et travaille.
          expect(watch.alive()).toBe(true);
          const before = readCounter(counter);
          const rise = await counterRise(counter, before, { watch });
          expect(rise.value, rise.why).toBeGreaterThan(before);
          // La commande SUIVANTE du même job le joint.
          const said = await run(
            await scope.startOwned({
              target: {
                file: process.execPath,
                args: [join(dir, 'probe.cjs'), join(dir, `one-${shape}.pid`)],
              },
              cwd: dir,
              env: env(),
            }),
          );
          expect(said.trim()).toBe(`alive ${pid}`);
        } finally {
          // La fin du job.
          await scope.close();
        }
        expect(await deadWithin(watch, 5_000)).toBe(true);
        const frozen = readCounter(counter);
        await new Promise((r) => setTimeout(r, 400));
        expect(readCounter(counter)).toBe(frozen);
      },
      60_000,
    );

    it.runIf(enabled)(
      'closing one job never kills the processes of another job',
      async () => {
        const a = new JobProcessScope(`owns-a-${randomUUID()}`, unconfined());
        const b = new JobProcessScope(`owns-b-${randomUUID()}`, unconfined());
        const da = await startDaemon(a, `a-${shape}`, shape);
        const db = await startDaemon(b, `b-${shape}`, shape);
        try {
          await a.close();
          expect(await deadWithin(da.watch, 5_000)).toBe(true);
          // L'autre job vit, et son démon travaille encore.
          expect(db.watch.alive()).toBe(true);
          const before = readCounter(db.counter);
          const rise = await counterRise(db.counter, before, { watch: db.watch });
          expect(rise.value, rise.why).toBeGreaterThan(before);
        } finally {
          await b.close();
        }
        expect(await deadWithin(db.watch, 5_000)).toBe(true);
      },
      60_000,
    );
  },
);

describe('a job owns every process it starts outside the sandbox (#750, #755) @cap:executer-une-commande/moteur', () => {
  it('the running command itself is killed with its whole tree by kill() (timeout, Stop)', async () => {
    const scope = new JobProcessScope(`owns-kill-${randomUUID()}`, unconfined());
    try {
      const pidFile = join(dir, 'long.pid');
      writeFileSync(
        join(dir, 'long.cjs'),
        "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);",
      );
      const proc = await scope.startOwned({
        target: { file: process.execPath, args: [join(dir, 'long.cjs'), pidFile] },
        cwd: dir,
        env: env(),
      });
      proc.stdout?.resume();
      proc.stderr?.resume();
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const watch = await watched(readCounter(pidFile));
      const killedAt = Date.now();
      proc.kill();
      // Sa fin arrive (taskkill /F rend un code de sortie 1 sous Windows, un
      // signal sous Unix : c'est l'appelant qui sait qu'il a coupé).
      await proc.done;
      expect(Date.now() - killedAt).toBeLessThan(5_000);
      expect(await deadWithin(watch, 5_000)).toBe(true);
    } finally {
      await scope.close();
    }
  }, 60_000);

  // Un runner mort ne ferme rien : seul ce qui retrouve un processus sans son
  // arbre (le Job Object, l'étiquette) peut le tuer — pas sous macOS.
  it.runIf(reachable)(
    'a runner killed outright leaves nothing of its job once the reclaiming runner calls killLeftoversOfJob (skipped where a detached descendant cannot be found: macOS)',
    async () => {
      const here = fileURLToPath(new URL('.', import.meta.url));
      const tsx = resolve(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const jobId = `owns-crash-${randomUUID()}`;
      const pidFile = join(dir, 'crash.pid');
      const counter = join(dir, 'crash.count');
      const ready = join(dir, 'crash.ready');
      writeFileSync(
        join(dir, 'fake-runner.mts'),
        [
          `import { JobProcessScope } from ${JSON.stringify(pathToFileURL(resolve(here, '..', 'job-scope.ts')).href)};`,
          `import { createSandbox } from ${JSON.stringify(pathToFileURL(resolve(here, '..', 'status.ts')).href)};`,
          `import { writeFileSync } from 'node:fs';`,
          `const scope = new JobProcessScope(${JSON.stringify(jobId)}, createSandbox(null, { platform: 'linux', log: () => {} }));`,
          `const p = await scope.startOwned({ target: { file: process.execPath, args: [${JSON.stringify(join(dir, 'spawner.cjs'))}, ${JSON.stringify(pidFile)}, ${JSON.stringify(counter)}, 'detached'] }, cwd: ${JSON.stringify(dir)}, env: { ...process.env } });`,
          `p.stdout?.resume(); p.stderr?.resume(); await p.done;`,
          `writeFileSync(${JSON.stringify(ready)}, 'ok');`,
          `setInterval(() => {}, 1000);`,
        ].join('\n'),
      );
      const runner = spawn(process.execPath, [tsx, join(dir, 'fake-runner.mts')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        // Sous Unix, le faux runner est chef de son groupe : le tuer, c'est
        // tuer SON groupe, pas celui du test.
        detached: process.platform !== 'win32',
      });
      let said = '';
      runner.stdout?.on('data', (d: Buffer) => (said += String(d)));
      runner.stderr?.on('data', (d: Buffer) => (said += String(d)));
      for (let i = 0; i < 400 && !(existsSync(ready) && existsSync(pidFile)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(pidFile), `the fake runner never started its daemon: ${said}`).toBe(true);
      const pid = readCounter(pidFile);
      const watch = await watched(pid);
      expect(watch.alive()).toBe(true);
      try {
        // Tué, pas arrêté : aucun code de fermeture ne tourne. Le faux runner
        // ENTIER (tsx relance le script dans un processus enfant) : son arbre
        // sous Windows, son groupe sous Unix. Le démon, détaché, n'est ni dans
        // l'un ni dans l'autre.
        const exited = new Promise<void>((r) => runner.once('exit', () => r()));
        if (process.platform === 'win32') {
          // kill-by-pid: `runner` is a child we hold and that lives (no exit yet).
          spawn('taskkill', ['/PID', String(runner.pid), '/T', '/F'], { windowsHide: true });
        } else {
          // kill-by-pid: the group of `runner`, a child we hold and that lives.
          process.kill(-(runner.pid as number), 'SIGKILL');
        }
        await exited;
        // Le runner qui reprend le job.
        await killLeftoversOfJob(jobId, () => undefined);
        expect(await deadWithin(watch, 5_000)).toBe(true);
      } finally {
        watch.kill();
      }
    },
    90_000,
  );
});

// Sous Windows, la forme que prennent les agents : une ligne shell qui détache
// un serveur par `start /b` — `cmd.exe` sort aussitôt, le serveur n'est plus
// rattaché à aucun arbre. Seul le Job Object du job le tient (#755).
describe.runIf(process.platform === 'win32')(
  'Windows without the sandbox: the job’s Job Object holds what `start /b` detaches (#755) @cap:executer-une-commande/moteur',
  () => {
    it('a `start /b` server outlives its command, then dies with the job', async () => {
      const scope = new JobProcessScope(`owns-start-${randomUUID()}`, unconfined());
      const pidFile = join(dir, 'start.pid');
      const counter = join(dir, 'start.count');
      try {
        const said = await run(
          await scope.startOwned({
            target: {
              command: `start "" /b "${process.execPath}" "${join(dir, 'daemon.cjs')}" "${counter}" "${pidFile}"`,
            },
            cwd: dir,
            env: env(),
          }),
        );
        expect(said).toBe('');
        for (let i = 0; i < 200 && !(existsSync(pidFile) && existsSync(counter)); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const watch = await watched(readCounter(pidFile));
        expect(watch.alive()).toBe(true);
        await scope.close();
        expect(await deadWithin(watch, 5_000)).toBe(true);
      } finally {
        await scope.close();
      }
    }, 60_000);
  },
);

// Sous Linux, ce que la fermeture retrouve, et ce qui lui échappe ENCORE — le
// fait mesuré, pas supposé (unix-job-processes.ts le dit en clair).
describe.runIf(process.platform === 'linux')(
  'Linux without the sandbox: what the job tag catches, and the limit it leaves (#750) @cap:executer-une-commande/moteur',
  () => {
    /** Le groupe de processus d'un pid, lu dans /proc/<pid>/stat (champ 5). */
    const pgidOf = (pid: number): number => {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    };

    it('measured: a detached (setsid) daemon has LEFT its command’s process group — only the job tag finds it', async () => {
      const scope = new JobProcessScope(`owns-setsid-${randomUUID()}`, unconfined());
      try {
        const { pid, watch } = await startDaemon(scope, 'setsid');
        // Sa propre session, son propre groupe : tuer le groupe de la commande
        // ne l'atteindrait pas (c'est ce que faisait la fin du job avant #750).
        expect(pgidOf(pid)).toBe(pid);
        await scope.close();
        expect(await deadWithin(watch, 5_000)).toBe(true);
      } finally {
        await scope.close();
      }
    }, 60_000);

    it('documented limit: a descendant started with an EMPTIED environment carries no tag and survives the job', async () => {
      const scope = new JobProcessScope(`owns-envi-${randomUUID()}`, unconfined());
      const pidFile = join(dir, 'envi.pid');
      const counter = join(dir, 'envi.count');
      let pid = 0;
      let watch: ProcessWatch | null = null;
      try {
        const proc = await scope.startOwned({
          target: {
            command: `env -i setsid "${process.execPath}" "${join(dir, 'daemon.cjs')}" "${counter}" "${pidFile}" > /dev/null 2>&1 &`,
          },
          cwd: dir,
          env: env(),
        });
        proc.stdout?.resume();
        proc.stderr?.resume();
        await proc.done;
        for (let i = 0; i < 200 && !existsSync(pidFile); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        pid = readCounter(pidFile);
        watch = await watched(pid);
        await scope.close();
        await new Promise((r) => setTimeout(r, 500));
        // La limite dite dans unix-job-processes.ts : ni groupe, ni étiquette.
        expect(watch.alive()).toBe(true);
      } finally {
        await scope.close();
        watch?.kill('SIGKILL');
      }
    }, 60_000);
  },
);
