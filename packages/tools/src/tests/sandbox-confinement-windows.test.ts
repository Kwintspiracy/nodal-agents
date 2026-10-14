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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSandboxStatus } from '@nodal-agents/sandbox';
import { runCommandTool } from '../builtin/run-command';
import { resolvePythonInterpreter } from '../builtin/run-skill-script';
import type { ToolContext } from '../types';

const isWindows = process.platform === 'win32';

let base: string;
let ws: string;
let canary: string;
const node = process.execPath;

function ctx(): ToolContext {
  return {
    jobId: 'job-sbx',
    agentId: 'agent-sbx',
    entityId: 'entity-sbx',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
  };
}

async function run(command: string, timeoutSeconds = 60) {
  return runCommandTool.execute(
    { purpose: 'sandbox test', command, timeout_seconds: timeoutSeconds },
    ctx(),
  );
}

/** Le canari est intact : un seul fichier, `existing.txt`, qui dit toujours `original`. */
async function expectCanaryIntact(): Promise<void> {
  expect(await readdir(canary)).toEqual(['existing.txt']);
  expect(await readFile(join(canary, 'existing.txt'), 'utf8')).toBe('original');
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
      const status = await getSandboxStatus();
      // Échoue fort, avec la raison, plutôt que de passer sans rien confiner.
      expect(status, JSON.stringify(status)).toEqual({
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
      expect(out.sandbox?.writableRoots).toContain(ws);
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
      expect(out.sandbox?.refusedWrites.map((r) => r.path)).toContain(target);
      expect(out.sandbox?.refusedWrites.find((r) => r.path === target)?.error).toMatch(/EPERM/);
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
      expect(out.sandbox?.refusedWrites.map((r) => r.path)).toContain(target);
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

    // Les trois petits-enfants : chacun écrit son pid dès qu'il démarre, puis
    // `after` au bout de 3 s s'il vit encore. La commande ATTEND le pid avant
    // de finir (`waitfor.cjs`) : sans cela, un petit-enfant lent à démarrer
    // serait tué avant d'avoir prouvé qu'il a tourné, et le test ne prouverait
    // rien.
    const grandchildFiles = async (): Promise<void> => {
      await writeFile(
        join(ws, 'bg.cjs'),
        "const fs = require('fs'); fs.writeFileSync(process.argv[2] + '.pid', String(process.pid)); setTimeout(() => fs.writeFileSync(process.argv[2], 'survived'), 3000);\n",
      );
      await writeFile(
        join(ws, 'waitfor.cjs'),
        "const fs = require('fs'); const t = Date.now(); (function poll() { if (fs.existsSync(process.argv[2])) return; if (Date.now() - t > 20000) process.exit(1); setTimeout(poll, 50); })();\n",
      );
    };
    const waitFor = (marker: string): string =>
      `"${node}" "${join(ws, 'waitfor.cjs')}" "${marker}.pid"`;

    it('a detached grandchild (spawn detached + unref) dies with the command', async () => {
      await grandchildFiles();
      await writeFile(
        join(ws, 'launcher.cjs'),
        "const c = require('child_process').spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }); c.unref(); console.log('launched', c.pid);\n",
      );
      const marker = join(ws, 'detached-after.txt');
      const out = await run(
        `"${node}" "${join(ws, 'launcher.cjs')}" "${join(ws, 'bg.cjs')}" "${marker}" && ${waitFor(marker)}`,
      );
      expect(out.exitCode, out.stderr).toBe(0);
      await expectGrandchildDead(marker);
    });

    it('a `start /b` grandchild dies with the command', async () => {
      await grandchildFiles();
      const marker = join(ws, 'startb-after.txt');
      const out = await run(
        `start "" /b "${node}" "${join(ws, 'bg.cjs')}" "${marker}" && ${waitFor(marker)}`,
      );
      expect(out.exitCode, out.stderr).toBe(0);
      await expectGrandchildDead(marker);
    });

    it('a PowerShell Start-Process grandchild dies with the command', async () => {
      await grandchildFiles();
      const marker = join(ws, 'startprocess-after.txt');
      const out = await run(
        `powershell -NoProfile -NonInteractive -Command "Start-Process -WindowStyle Hidden -FilePath '${node}' -ArgumentList '\\"${join(ws, 'bg.cjs')}\\"','\\"${marker}\\"'" && ${waitFor(marker)}`,
      );
      expect(out.exitCode, out.stderr).toBe(0);
      await expectGrandchildDead(marker);
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
    it('the status names the tier; the command runs; the result carries no `sandbox` report', async () => {
      expect(hereStatus?.state === 'unavailable' && hereStatus.reason).toMatch(/^isolationTier=/);
      ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-sbx-unsupported-')));
      try {
        const out = await run(`echo ok> "${join(ws, 'inside.txt')}"`);
        expect(out.exitCode).toBe(0);
        expect((await readFile(join(ws, 'inside.txt'), 'utf8')).trim()).toBe('ok');
        expect(out.sandbox).toBeUndefined();
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    });
  },
);

/** Le petit-enfant a démarré (il a écrit son pid), puis n'a pas survécu à la commande. */
async function expectGrandchildDead(marker: string): Promise<void> {
  // Le pid est écrit au démarrage ; s'il manque, le petit-enfant n'a jamais
  // tourné et le test ne prouverait rien.
  const pidFile = `${marker}.pid`;
  for (let i = 0; i < 20 && !existsSync(pidFile); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(existsSync(pidFile), 'the grandchild never started').toBe(true);
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  // Il devait écrire au bout de 3 s ; on en attend 5.
  await new Promise((r) => setTimeout(r, 5_000));
  const survived = alive(pid);
  if (survived) {
    try {
      process.kill(pid);
    } catch {
      /* déjà mort */
    }
  }
  expect(existsSync(marker)).toBe(false);
  expect(survived).toBe(false);
}
