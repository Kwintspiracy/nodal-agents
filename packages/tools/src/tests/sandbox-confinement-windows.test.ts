// sandbox-confinement-windows.test.ts — le bac à sable de #628 (étape 1), sous
// Windows, éprouvé à travers le VRAI `run_command` : une commande confinée
// écrit dans son workspace, et n'écrit NULLE PART ailleurs, par aucun des
// chemins détournés que les essais #731 / #733 ont mesurés.
//
// Le témoin : un dossier `canary` frère du workspace, qui contient
// `existing.txt` = `original`. Après chaque tentative, il ne contient que ce
// fichier, avec ce contenu — l'assertion porte sur le DISQUE, pas sur le code
// de sortie (`del` rend 0 même quand il échoue, mesure 1f).
//
// WINDOWS SEULEMENT, et dit dans le titre : le backend macOS (Seatbelt) et le
// backend Linux (Landlock) viennent dans les PR suivantes de #628. Sous
// Windows, un bac à sable INDISPONIBLE fait échouer la suite avec sa raison
// (Node trop ancien, MXC non supporté…) — jamais un vert par absence.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeJobProcessScope,
  createSandbox,
  getSandboxStatus,
  jobProcessScope,
  mxcBackend,
  type RefusedWrite,
} from '@nodal-agents/sandbox';
import type { SandboxReport } from '../builtin/shell-engine';
import { mustDie, readCounter, watchRegistry } from '@nodal-agents/test-kit';
import { runCommandTool } from '../builtin/run-command';
import { resolvePythonInterpreter } from '../builtin/run-skill-script';
import type { ToolContext } from '../types';

const isWindows = process.platform === 'win32';

let base: string;
let ws: string;
let canary: string;
const node = process.execPath;

/**
 * Le bac à sable de la batterie : le VRAI backend MXC, sous la valeur de test
 * de la politique réseau — `deny-all` (windows-mxc.ts), aucun réseau, aucun
 * proxy. C'est voulu : cette suite prouve le mur des ÉCRITURES et la VIE des
 * processus d'un job (vivants jusqu'à la fin, morts après), qui ne dépendent
 * d'aucun réseau. `deny-all` plutôt que `egress allow` pour qu'aucune fuite ne
 * se cache derrière un réseau ouvert. La JOIGNABILITÉ d'un serveur par la
 * commande suivante passe par le proxy : elle est prouvée à part, sous la
 * valeur PRODUIT `proxy` (sandbox-proxy-windows.test.ts), sur 9711. `deny-all`
 * et `proxy` sont deux valeurs de l'unique paramètre, pas une branche de test.
 *
 * Le courtier tourne sur le Node dédié que Nodal télécharge (D5), quel que
 * soit le Node du runner de test : la suite marche donc même sur 9711, dont
 * le Node est 26.4 (hors plage du SDK).
 */
const batterySandbox = createSandbox(mxcBackend(undefined, 'deny-all'));

function ctx(jobId = 'job-sbx', signal?: AbortSignal): ToolContext {
  return {
    jobId,
    ...(signal ? { signal } : {}),
    agentId: 'agent-sbx',
    entityId: 'entity-sbx',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
  };
}

async function run(
  command: string,
  timeoutSeconds = 60,
  opts: { jobId?: string; signal?: AbortSignal } = {},
) {
  const c = ctx(opts.jobId, opts.signal);
  // Le périmètre du job, ouvert sous le bac à sable de la batterie ; le vrai
  // `run_command` le reprend tel quel (jobProcessScope).
  jobProcessScope(c.jobId, batterySandbox);
  return runCommandTool.execute(
    { purpose: 'sandbox test', command, timeout_seconds: timeoutSeconds },
    c,
  );
}

/** Le canari est intact : un seul fichier, `existing.txt`, qui dit toujours `original`. */
async function expectCanaryIntact(): Promise<void> {
  expect(await readdir(canary)).toEqual(['existing.txt']);
  expect(await readFile(join(canary, 'existing.txt'), 'utf8')).toBe('original');
}

/** Les écritures refusées d'un résultat CONFINÉ ; un résultat non confiné fait échouer. */
function refusedOf(out: { sandbox?: SandboxReport }): readonly RefusedWrite[] {
  if (!out.sandbox?.confined) throw new Error(`not confined: ${JSON.stringify(out.sandbox)}`);
  return out.sandbox.refusedWrites ?? [];
}

// La vie d'un serveur se lit sur le processus TENU, jamais sur son pid : Windows
// redonne un pid libéré en quelques secondes (test-kit process-watch.ts), et
// `process.kill(pid, 0)` dit alors « vivant » d'un inconnu (CI, run 39874357868).
// La veille s'ouvre dès que le pid est lu ; un serveur qui survit à la fin de
// son job fait échouer le test en le disant (« held since … still alive … ms
// after closeJobProcessScope ») : ce n'est pas une réutilisation de pid, c'est
// un processus qui n'est pas mort.
const watches = watchRegistry();
afterEach(() => watches.releaseAll());

/**
 * Un Windows sans le palier MXC base-container (Windows Server, dont le runner
 * Windows de GitHub, ou un Windows plus ancien) : MXC n'y confine qu'en
 * réécrivant les ACL de tout le lecteur, et le bac à sable s'y dit
 * indisponible (SANDBOX_PLATFORM_UNSUPPORTED). La batterie de confinement n'a
 * alors rien à prouver ; la suite qui la remplace prouve que la commande
 * tourne et que la raison est dite. Toute AUTRE indisponibilité (Node trop
 * ancien, SDK absent) fait échouer la batterie, avec sa raison.
 */
const hereStatus = isWindows ? await getSandboxStatus() : undefined;
const tierUnsupported =
  hereStatus?.state === 'unavailable' && hereStatus.code === 'SANDBOX_PLATFORM_UNSUPPORTED';

describe.skipIf(!isWindows || tierUnsupported)(
  'sandbox, Windows (MXC) — run_command writes only inside its folders @cap:executer-une-commande/moteur (Windows only: the macOS and Linux backends come in later PRs of #628 — skipped on a Windows without the MXC base-container tier, e.g. the GitHub Windows Server runner)',
  () => {
    beforeAll(async () => {
      const status = await batterySandbox.status();
      // Échoue fort, avec la raison, plutôt que de passer sans rien confiner.
      // `limits` (la boucle locale de la machine, fermée sur certains builds)
      // ne touche pas à ce que cette suite prouve.
      expect(status, JSON.stringify(status)).toMatchObject({
        state: 'available',
        backend: 'mxc-processcontainer',
      });
      base = await realpath(await mkdtemp(join(tmpdir(), 'nodal-sbx-')));
      ws = join(base, 'ws');
      canary = join(base, 'canary');
      await mkdir(ws);
      await mkdir(canary);
      await writeFile(join(canary, 'existing.txt'), 'original');
      await writeFile(
        join(ws, 'write.cjs'),
        "require('fs').writeFileSync(process.argv[2], 'x'); console.log('wrote');\n",
      );
    });

    afterAll(async () => {
      await closeJobProcessScope('job-sbx');
      for (let i = 0; i < 5; i++) {
        try {
          await rm(base, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    });

    it('writes inside its workspace', async () => {
      const out = await run(`echo ok> "${join(ws, 'inside.txt')}"`);
      expect(out.exitCode).toBe(0);
      expect((await readFile(join(ws, 'inside.txt'), 'utf8')).trim()).toBe('ok');
      expect(out.sandbox).toMatchObject({ confined: true });
      expect(out.sandbox.confined && out.sandbox.writableRoots).toContain(ws);
    });

    it('shell redirection outside: refused, canary intact', async () => {
      const out = await run(`echo x> "${join(canary, 'shell.txt')}"`);
      await expectCanaryIntact();
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toMatch(/denied/i);
    });

    it('overwriting an existing file outside: refused, canary intact', async () => {
      const out = await run(`echo pwned> "${join(canary, 'existing.txt')}"`);
      await expectCanaryIntact();
      expect(out.exitCode).not.toBe(0);
    });

    it('node -e outside: refused, canary intact, the refusal names the path', async () => {
      const target = join(canary, 'node.txt');
      const out = await run(`"${node}" "${join(ws, 'write.cjs')}" "${target}"`);
      await expectCanaryIntact();
      expect(out.exitCode).not.toBe(0);
      expect(refusedOf(out).map((r) => r.path)).toContain(target);
      expect(refusedOf(out).find((r) => r.path === target)?.error).toMatch(/EPERM/);
    });

    it('a Python script outside: refused, canary intact, the refusal names the path', async () => {
      const python = await resolvePythonInterpreter();
      // Pas de Python sur la machine : le cas ne peut pas être joué, et le dire.
      expect(python, 'no Python interpreter on this machine').not.toBeNull();
      const target = join(canary, 'py.txt');
      await writeFile(
        join(ws, 'escape.py'),
        "import sys\nopen(sys.argv[1], 'w').write('x')\nprint('wrote')\n",
      );
      const out = await run(`${python} "${join(ws, 'escape.py')}" "${target}"`);
      await expectCanaryIntact();
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toMatch(/PermissionError/);
      expect(refusedOf(out).map((r) => r.path)).toContain(target);
    });

    it('a child process outside: refused, canary intact', async () => {
      const childCmd = `cmd /c echo x> "${join(canary, 'child.txt')}"`;
      await writeFile(
        join(ws, 'child.cjs'),
        `try { require('child_process').execSync(${JSON.stringify(childCmd)}, { stdio: 'inherit' }); console.log('child ok'); } catch (e) { process.exit(3); }\n`,
      );
      const out = await run(`"${node}" "${join(ws, 'child.cjs')}"`);
      await expectCanaryIntact();
      expect(out.exitCode).toBe(3);
    });

    it('a junction created by the command, written through: refused, canary intact', async () => {
      const link = join(ws, 'jlink');
      await run(`mklink /J "${link}" "${canary}" && echo x> "${join(link, 'junction.txt')}"`);
      await expectCanaryIntact();
    });

    it('a symlink created by node, written through: refused, canary intact', async () => {
      await writeFile(
        join(ws, 'symlink.cjs'),
        "const fs = require('fs'); fs.symlinkSync(process.argv[2], process.argv[3], 'dir'); fs.writeFileSync(require('path').join(process.argv[3], 'symlink.txt'), 'x');\n",
      );
      await run(`"${node}" "${join(ws, 'symlink.cjs')}" "${canary}" "${join(ws, 'slink')}"`);
      await expectCanaryIntact();
    });

    it('a junction made BEFORE the command (outside the sandbox), written through: refused', async () => {
      const link = join(ws, 'prelink');
      const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, canary], { windowsHide: true });
      expect(made.status).toBe(0);
      const out = await run(`echo x> "${join(link, 'prelink.txt')}"`);
      await expectCanaryIntact();
      expect(out.exitCode).not.toBe(0);
    });

    it('rename OUT of the workspace (move, fs.renameSync): refused, the file stays inside', async () => {
      await writeFile(join(ws, 'to-move.txt'), 'mine');
      await run(`move "${join(ws, 'to-move.txt')}" "${join(canary, 'moved.txt')}"`);
      await writeFile(
        join(ws, 'rename.cjs'),
        'require("fs").renameSync(process.argv[2], process.argv[3]);\n',
      );
      await run(
        `"${node}" "${join(ws, 'rename.cjs')}" "${join(ws, 'to-move.txt')}" "${join(canary, 'moved2.txt')}"`,
      );
      await expectCanaryIntact();
      expect(await readFile(join(ws, 'to-move.txt'), 'utf8')).toBe('mine');
    });

    it('delete outside (del, fs.unlinkSync, rmdir): refused, canary intact', async () => {
      // `del` rend 0 même quand il échoue (mesure 1f) : seul le disque fait foi.
      await run(`del /f /q "${join(canary, 'existing.txt')}"`);
      await writeFile(join(ws, 'unlink.cjs'), 'require("fs").unlinkSync(process.argv[2]);\n');
      await run(`"${node}" "${join(ws, 'unlink.cjs')}" "${join(canary, 'existing.txt')}"`);
      await run(`rmdir /s /q "${canary}"`);
      await expectCanaryIntact();
    });

    // LA DURÉE DE VIE (décision du 14/10) : ce qu'une commande laisse tourner
    // vit jusqu'à la fin du JOB, puis meurt quand le runner ferme son
    // périmètre. Chaque processus d'arrière-plan écrit son pid et son port
    // dès qu'il écoute ; la commande ATTEND ce fichier (`waitfor.cjs`) avant
    // de finir, sans quoi un processus lent à démarrer ne prouverait rien.
    const lifetimeFiles = async (): Promise<void> => {
      await writeFile(
        join(ws, 'server.cjs'),
        "const fs = require('fs'); require('http').createServer((q, s) => s.end('pong ' + process.pid)).listen(0, '127.0.0.1', function () { fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: this.address().port })); });\n",
      );
      await writeFile(
        join(ws, 'waitfor.cjs'),
        "const fs = require('fs'); const t = Date.now(); (function poll() { if (fs.existsSync(process.argv[2])) return; if (Date.now() - t > 20000) process.exit(1); setTimeout(poll, 50); })();\n",
      );
      await writeFile(
        join(ws, 'launcher.cjs'),
        "const c = require('child_process').spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }); c.unref();\n",
      );
    };
    const waitFor = (info: string): string => `"${node}" "${join(ws, 'waitfor.cjs')}" "${info}"`;
    const readInfo = async (info: string): Promise<{ pid: number; port: number }> => {
      // `writeFileSync` vide le fichier avant d'y écrire : la commande qui
      // attend son EXISTENCE peut le lire vide. On relit, borné.
      let text = '';
      for (let i = 0; i < 100; i++) {
        text = await readFile(info, 'utf8');
        if (text.trim() !== '') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return JSON.parse(text) as { pid: number; port: number };
    };

    /** Les trois façons de laisser un serveur tourner, sous cmd.exe. */
    const backgroundForms: { name: string; command: (info: string) => string }[] = [
      {
        name: 'start /b',
        command: (info) => `start "" /b "${node}" "${join(ws, 'server.cjs')}" "${info}"`,
      },
      {
        name: 'a detached child (spawn detached + unref)',
        command: (info) =>
          `"${node}" "${join(ws, 'launcher.cjs')}" "${join(ws, 'server.cjs')}" "${info}"`,
      },
      {
        name: 'PowerShell Start-Process',
        command: (info) =>
          `powershell -NoProfile -NonInteractive -Command "Start-Process -WindowStyle Hidden -FilePath '${node}' -ArgumentList '\\"${join(ws, 'server.cjs')}\\"','\\"${info}\\"'"`,
      },
    ];

    // La VIE du processus, par son pid — indépendante du réseau (`deny-all`
    // ici). La JOIGNABILITÉ par la commande suivante, qui passe par le proxy,
    // est prouvée sous la valeur `proxy` dans sandbox-proxy-windows.test.ts.
    // Marge de la commande 1 : la forme PowerShell Start-Process démarre
    // powershell.exe + un processus caché dans un conteneur frais, LENT sur
    // runner arm (jusqu'à ~60 s mesurés le 15/10, run 38733799656). On lui
    // laisse donc 180 s et le cas 240 s, pour garder cette forme — les agents
    // lancent de vrais serveurs ainsi sous Windows.
    it.each(backgroundForms)(
      '$name: the server outlives its command, and it dies when the job ends',
      async ({ name, command }) => {
        await lifetimeFiles();
        const jobId = `job-sbx-life-${name.replace(/[^a-z]+/gi, '-')}`;
        const info = join(ws, `${jobId}.json`);
        const first = await run(`${command(info)} && ${waitFor(info)}`, 180, { jobId });
        expect(first.exitCode, first.stderr).toBe(0);
        const { pid } = await readInfo(info);
        const server = await watches.hold(pid);
        expect(server.alive(), `${name}: the server outlives its command`).toBe(true);
        expect(await closeJobProcessScope(jobId)).toBe(true);
        await mustDie(server, `${name} server`, 'closeJobProcessScope');
      },
      240_000,
    );

    it('closing one job does not touch another job’s processes', async () => {
      await lifetimeFiles();
      const infoA = join(ws, 'job-a.json');
      const infoB = join(ws, 'job-b.json');
      const start = (info: string): string =>
        `start "" /b "${node}" "${join(ws, 'server.cjs')}" "${info}" && ${waitFor(info)}`;
      await run(start(infoA), 60, { jobId: 'job-sbx-a' });
      await run(start(infoB), 60, { jobId: 'job-sbx-b' });
      const a = await watches.hold((await readInfo(infoA)).pid);
      const b = await watches.hold((await readInfo(infoB)).pid);
      await closeJobProcessScope('job-sbx-a');
      await mustDie(a, 'server of job A', 'closeJobProcessScope(A)');
      // L'autre job vit encore : son serveur tenu n'est pas mort.
      expect(b.alive(), 'the server of job B, after job A closed').toBe(true);
      await closeJobProcessScope('job-sbx-b');
      await mustDie(b, 'server of job B', 'closeJobProcessScope(B)');
    });

    it('Stop (the job signal) kills the running command at once', async () => {
      await writeFile(
        join(ws, 'long.cjs'),
        "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 600000);\n",
      );
      const pidFile = join(ws, 'stop.pid');
      const controller = new AbortController();
      const started = Date.now();
      const running = run(`"${node}" "${join(ws, 'long.cjs')}" "${pidFile}"`, 600, {
        jobId: 'job-sbx-stop',
        signal: controller.signal,
      });
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const long = await watches.hold(readCounter(pidFile));
      controller.abort();
      const out = await running;
      expect(out.exitCode).toBeNull();
      expect(out.stderr).toContain('spawn_error: ABORTED');
      expect(Date.now() - started).toBeLessThan(30_000);
      await mustDie(long, 'the stopped command', 'Stop (the job signal)');
      await closeJobProcessScope('job-sbx-stop');
    });

    it('npm install of a local tarball works confined (offline, cache in the Nodal tool cache)', async () => {
      // Le paquet est fabriqué ici, hors bac à sable : aucun réseau n'est lu.
      const pkg = join(base, 'tiny-pkg');
      await mkdir(pkg);
      await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({ name: 'nodal-tiny', version: '1.0.0', main: 'index.js' }),
      );
      await writeFile(join(pkg, 'index.js'), "module.exports = 'tiny';\n");
      const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', base], {
        cwd: pkg,
        shell: true,
        encoding: 'utf8',
      });
      expect(packed.status, packed.stderr).toBe(0);
      const tarball = join(base, 'nodal-tiny-1.0.0.tgz');
      expect(existsSync(tarball)).toBe(true);

      const proj = join(ws, 'proj');
      await mkdir(proj);
      await writeFile(
        join(proj, 'package.json'),
        JSON.stringify({ name: 'proj', version: '1.0.0' }),
      );
      const out = await runCommandTool.execute(
        {
          purpose: 'sandbox test',
          command: `npm install "${tarball}" --offline --no-audit --no-fund`,
          cwd: 'proj',
          timeout_seconds: 120,
        },
        ctx(),
      );
      expect(out.exitCode, out.stderr).toBe(0);
      expect(
        JSON.parse(
          await readFile(join(proj, 'node_modules', 'nodal-tiny', 'package.json'), 'utf8'),
        ),
      ).toMatchObject({ name: 'nodal-tiny', version: '1.0.0' });
      // Le cache npm a bien atterri dans le cache d'outils de Nodal.
      const cacheRoot = process.env['NODALAI_TOOL_CACHE_ROOT'];
      expect(cacheRoot).toBeDefined();
      expect(existsSync(join(cacheRoot as string, 'npm', '_cacache'))).toBe(true);
      await expectCanaryIntact();
    });
  },
);

describe.runIf(isWindows && tierUnsupported)(
  'sandbox, Windows without the MXC base-container tier — run_command runs unconfined and the reason is said @cap:executer-une-commande/moteur',
  () => {
    it('the status names the tier; the command runs; its result says it was not confined, with the code', async () => {
      expect(hereStatus?.state === 'unavailable' && hereStatus.reason).toMatch(/^isolationTier=/);
      ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-sbx-unsupported-')));
      try {
        const out = await run(`echo ok> "${join(ws, 'inside.txt')}"`);
        expect(out.exitCode).toBe(0);
        expect((await readFile(join(ws, 'inside.txt'), 'utf8')).trim()).toBe('ok');
        // Le résultat le DIT : la commande n'a pas été confinée, et pourquoi.
        expect(out.sandbox).toEqual({ confined: false, code: 'SANDBOX_PLATFORM_UNSUPPORTED' });
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    });
  },
);
