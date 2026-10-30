// nodal-programs.test.ts — un programme de Nodal (git) lancé sur un dépôt
// qu'une commande confinée a pu piéger n'exécute RIEN sur l'hôte (#628, audit
// P1-2). Le piège : un `core.fsmonitor` et un filtre (`filter.*.clean`) dans
// le `.git/config` du dépôt, deux commandes que git exécute sur `git status`.
//
// Le TÉMOIN prouve que le piège est armé : sur l'hôte (`hostPrograms`, ce que
// faisait Nodal), git l'exécute et le fichier marqueur apparaît. Dans le bac à
// sable, la trace de git (GIT_TRACE) montre qu'il LANCE bien la commande
// plantée — le piège est honoré, le test n'est pas vide — et le marqueur de
// l'hôte reste absent : ce qu'elle fait reste dans le conteneur.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostPrograms, nodalProgramsSandbox, openNodalPrograms } from '../nodal-programs';
import { noWorkspaceSandbox } from '../policy';
import { createSandbox } from '../status';
import type { SandboxBackend } from '../types';

const isWindows = process.platform === 'win32';
const fwd = (p: string): string => p.split('\\').join('/');

/** Le git de la machine, par son chemin absolu. */
function gitPath(): string {
  const out = execFileSync(isWindows ? 'where' : 'which', ['git'], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .find((l) => l.trim() !== '')!
    .trim();
}

let root = '';
let repo = '';
let hook = '';
let hostMarker = '';

/**
 * Un dépôt piégé : `core.fsmonitor` et un filtre `clean` lancent un script qui
 * écrit un marqueur HORS de toute racine du conteneur.
 */
function plantedRepo(): void {
  root = mkdtempSync(join(tmpdir(), 'nodal-programs-'));
  repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  hostMarker = join(root, 'HOST-MARKER');
  hook = join(root, 'hook.cjs');
  writeFileSync(hook, `require('fs').appendFileSync(${JSON.stringify(hostMarker)}, 'ran');\n`);
  const g = (...a: string[]): void => {
    execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  };
  g('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', 'a.txt');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const cmd = `node "${fwd(hook)}"`;
  g('config', 'core.fsmonitor', cmd);
  g('config', 'filter.evil.clean', cmd);
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil\n');
  // Un fichier suivi modifié : `status` le compare, donc lance le filtre.
  writeFileSync(join(repo, 'a.txt'), 'two\n');
}

beforeEach(plantedRepo);
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* un conteneur qui tarde à lâcher un fichier : laissé à l'OS */
  }
});

describe('hostPrograms — the host path, unchanged @cap:executer-une-commande/moteur', () => {
  it('TÉMOIN : sur l’hôte, git exécute le piège (le marqueur de l’hôte apparaît)', async () => {
    const r = await hostPrograms.execFile(gitPath(), ['status', '--porcelain'], {
      cwd: repo,
      writableRoots: [],
      readableRoots: [repo],
    });
    expect(r.stdout).toMatch(/a\.txt/);
    expect(existsSync(hostMarker)).toBe(true);
  });

  it('rejette comme execFile : code non nul dans `code`, borne de temps dans `killed`', async () => {
    const node = process.execPath;
    const fail = await hostPrograms
      .execFile(node, ['-e', 'process.exit(3)'], { writableRoots: [], readableRoots: [] })
      .catch((e: unknown) => e as { code?: unknown; killed?: boolean });
    expect(fail).toMatchObject({ code: 3 });
    const slow = await hostPrograms
      .execFile(node, ['-e', 'setTimeout(() => {}, 30000)'], {
        timeout: 300,
        writableRoots: [],
        readableRoots: [],
      })
      .catch((e: unknown) => e as { killed?: boolean });
    expect(slow).toMatchObject({ killed: true });
  });
});

// La disponibilité du bac à sable des programmes est sondée à la collecte.
const confined = isWindows && (await nodalProgramsSandbox().status()).state === 'available';

describe.runIf(confined)(
  'openNodalPrograms — git on a planted repo runs IN the sandbox, nothing on the host @cap:executer-une-commande/moteur (Windows, MXC available)',
  () => {
    it('git lance la commande plantée (trace) DANS le conteneur, JAMAIS sur l’hôte ; sa sortie est juste', async () => {
      const programs = await openNodalPrograms({ workspace: noWorkspaceSandbox });
      let stderr = '';
      try {
        expect(programs.confined).toBe(true);
        // Le dépôt en écriture : git doit pouvoir `chdir` dans son arbre de
        // travail, ce que MXC refuse en lecture seule (nodal-programs.ts).
        const r = await programs.execFile(gitPath(), ['status', '--porcelain'], {
          cwd: repo,
          env: { ...process.env, GIT_TRACE: '2' },
          writableRoots: [repo],
          readableRoots: [],
        });
        expect(r.stdout).toMatch(/a\.txt/);
        stderr = r.stderr;
      } finally {
        await programs.close();
      }
      const launched = stderr
        .split('\n')
        .filter((l) => l.includes('run_command:') && l.includes(fwd(hook)));
      expect(launched.length, stderr).toBeGreaterThan(0);
      expect(existsSync(hostMarker), 'the planted command ran on the HOST').toBe(false);
    }, 60_000);

    it('rejette comme execFile dans le conteneur : `code` non nul, `killed` sur la borne', async () => {
      const programs = await openNodalPrograms({ workspace: noWorkspaceSandbox });
      try {
        const node = process.execPath;
        const fail = await programs
          .execFile(node, ['-e', 'process.exit(3)'], { writableRoots: [], readableRoots: [] })
          .catch((e: unknown) => e as { code?: unknown });
        expect(fail).toMatchObject({ code: 3 });
        const slow = await programs
          .execFile(node, ['-e', 'setTimeout(() => {}, 30000)'], {
            timeout: 500,
            writableRoots: [],
            readableRoots: [],
          })
          .catch((e: unknown) => e as { killed?: boolean });
        expect(slow).toMatchObject({ killed: true });
      } finally {
        await programs.close();
      }
    }, 60_000);
  },
);

// ─── #876 : l'interrupteur de l'espace couvre aussi les programmes de Nodal ──

/** Un bac à sable DISPONIBLE dont le conteneur ne s'ouvre jamais : s'il servait, le test le dirait. */
function availableSandbox(): ReturnType<typeof createSandbox> {
  const backend: SandboxBackend = {
    probe: async () => ({ state: 'available', backend: 'fake' }),
    openContainer: async () => {
      throw new Error('CONTAINER_OPENED');
    },
  };
  return createSandbox(backend, { log: () => {} });
}

describe('openNodalPrograms — the workspace switch @cap:executer-une-commande/moteur', () => {
  it('switched off: the session runs on the host, and the program really runs there', async () => {
    let reads = 0;
    const programs = await openNodalPrograms({
      sandbox: availableSandbox(),
      workspace: async () => {
        reads++;
        return { enabled: false, folders: { added: [], removed: [] } };
      },
    });
    try {
      expect(programs.confined).toBe(false);
      const r = await programs.execFile(process.execPath, ['-e', 'process.stdout.write("host")'], {
        writableRoots: [],
        readableRoots: [],
      });
      expect(r.stdout).toBe('host');
    } finally {
      await programs.close();
    }
    expect(reads).toBe(1);
  });

  it('switched on: the session goes through the sandbox (its container is asked for)', async () => {
    const programs = await openNodalPrograms({
      sandbox: availableSandbox(),
      workspace: noWorkspaceSandbox,
    });
    try {
      expect(programs.confined).toBe(true);
      await expect(
        programs.execFile(process.execPath, ['-e', '0'], { writableRoots: [], readableRoots: [] }),
      ).rejects.toThrow('CONTAINER_OPENED');
    } finally {
      await programs.close();
    }
  });

  it('an unreadable setting opens no session at all, it is never read as on or off', async () => {
    await expect(
      openNodalPrograms({
        sandbox: availableSandbox(),
        workspace: async () => {
          throw new Error('SANDBOX_SETTINGS_UNREADABLE: test');
        },
      }),
    ).rejects.toThrow('SANDBOX_SETTINGS_UNREADABLE');
  });
});
