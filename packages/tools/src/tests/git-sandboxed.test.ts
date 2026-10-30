// git-sandboxed.test.ts — le git que NODAL lance sur un workspace ne doit rien
// exécuter sur l'hôte de ce qu'une commande confinée y a planté (#628, audit
// P1-2, décision A du 16/10).
//
// Le piège est posé PAR UNE COMMANDE CONFINÉE (un conteneur MXC du job, dont le
// workspace est le seul dossier inscriptible) : un `core.fsmonitor` et un filtre
// `clean` dans le `.git/config` du dépôt, ou un `core.fsmonitor` dans un
// SOUS-DÉPÔT imbriqué (que `snapshot`, le statut figé et la restauration font
// lire à un git enfant). La commande plantée écrit un marqueur HORS de toute
// racine du conteneur : s'il apparaît, elle a tourné sur l'hôte.
//
// Les chemins testés sont ceux du produit : les deux phases du constat git
// (`snapshotGitAvant` / `constatedGitWrites`), la photo d'un tour par le vrai
// `executeTool`, le repli du constat sur l'index figé, la restauration. Le
// TÉMOIN (même piège, git sur l'hôte) prouve que le piège est armé : sans lui,
// un marqueur absent ne prouverait rien.
//
// Windows, là où le bac à sable des programmes de Nodal est disponible
// (MXC, palier base-container) : sur ta machine et sous release:check.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSandbox,
  hostPrograms,
  JobProcessScope,
  mxcBackend,
  nodalProgramsSandbox,
  withNodalPrograms,
  noWorkspaceSandbox,
} from '@nodal-agents/sandbox';
import { restoreCheckpoint, snapshot, listCheckpoints } from '@nodal-agents/checkpoints';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { resolveGitBinary } from '@nodal-agents/shared/git-binary';
import { executeTool } from '../execute';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { constatedGitWrites, snapshotGitAvant } from '../verification/git-constat';
import type { ToolContext } from '../types';

const fwd = (p: string): string => p.split('\\').join('/');

// Le bac à sable des programmes de Nodal : sondé à la collecte.
const available =
  process.platform === 'win32' && (await nodalProgramsSandbox().status()).state === 'available';

/** Le conteneur d'un job, où la commande qui pose le piège tourne. */
const jobSandbox = createSandbox(mxcBackend(undefined, 'deny-all'), { log: () => {} });

let root = '';
let ws = '';
let store = '';
let marker = '';
let hook = '';
let git = '';

/** Lance `node script` DANS le conteneur d'un job dont `ws` est inscriptible. */
async function confined(script: string, cwd: string = ws): Promise<void> {
  const scope = new JobProcessScope('git-sandboxed-plant', jobSandbox);
  try {
    const env: Record<string, string | undefined> = {};
    for (const n of ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'LOCALAPPDATA', 'USERPROFILE']) {
      env[n] = process.env[n];
    }
    const c = await scope.container([ws], env);
    const p = await c.start({ target: { file: process.execPath, args: [script] }, cwd, env });
    let err = '';
    p.stderr?.on('data', (d: Buffer) => (err += String(d)));
    const end = await p.done;
    expect(end, err).toEqual({ kind: 'exit', exitCode: 0 });
  } finally {
    await scope.close();
  }
}

/** Un script, hors du workspace, que la commande confinée exécute. */
async function plantScript(body: string): Promise<string> {
  const p = join(root, `plant-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(
    p,
    `const { execFileSync } = require('child_process');\n` +
      `const fs = require('fs');\n` +
      `const git = ${JSON.stringify(git)};\n` +
      `const hook = ${JSON.stringify(`node "${fwd(hook)}"`)};\n` +
      body,
  );
  return p;
}

function hostGit(cwd: string, ...args: string[]): void {
  execFileSync(git, args, { cwd, stdio: 'ignore' });
}

beforeAll(async () => {
  git = (await resolveGitBinary()) ?? '';
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nodal-gitsb-')));
  ws = join(root, 'ws');
  store = join(root, 'checkpoints');
  await mkdir(ws, { recursive: true });
  marker = join(root, 'HOST-MARKER');
  hook = join(root, 'hook.cjs');
  await writeFile(hook, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran');\n`);
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* un conteneur qui tarde à lâcher un fichier : laissé à l'OS */
  }
});

describe.runIf(available)(
  'the constat’s git runs in the sandbox: a planted core.fsmonitor and filter never run on the host @cap:executer-une-commande/moteur (Windows, MXC available)',
  () => {
    /** Un dépôt au workspace ; une commande confinée y plante les deux pièges. */
    async function plantedRepo(): Promise<void> {
      hostGit(ws, 'init', '-q');
      await writeFile(join(ws, 'a.txt'), 'one\n');
      hostGit(ws, 'add', 'a.txt');
      hostGit(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      await confined(
        await plantScript(
          `execFileSync(git, ['config', 'core.fsmonitor', hook]);\n` +
            `execFileSync(git, ['config', 'filter.evil.clean', hook]);\n` +
            `fs.writeFileSync('.gitattributes', '*.txt filter=evil\\n');\n` +
            `fs.writeFileSync('a.txt', 'two\\n');\n`,
        ),
      );
    }

    it('TÉMOIN : le même git, sur l’hôte, exécute le piège', async () => {
      await plantedRepo();
      await hostPrograms.execFile(git, ['status', '--porcelain'], {
        cwd: ws,
        writableRoots: [],
        readableRoots: [],
      });
      expect(existsSync(marker), 'the trap is not armed: this test would prove nothing').toBe(true);
    });

    it('les deux phases du constat lisent le dépôt piégé sans rien lancer sur l’hôte, et constatent l’écriture', async () => {
      await plantedRepo();
      const before = await snapshotGitAvant([ws], noWorkspaceSandbox);
      expect(before.length).toBe(1);
      await writeFile(join(ws, 'nouveau.txt'), 'écrit pendant l’appel\n');
      const after = await constatedGitWrites(before, noWorkspaceSandbox);
      expect(after.writes.map((w) => w.path)).toContain(fwd(join(ws, 'nouveau.txt')));
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);
  },
);

describe.runIf(available)(
  'checkpoints’ git runs in the sandbox: a planted sub-repository never runs on the host @cap:executer-une-commande/moteur (Windows, MXC available)',
  () => {
    let db: TestDb;
    let seed: Awaited<ReturnType<typeof seedMinimal>>;

    beforeAll(async () => {
      db = (await spinUpTestDb()).db;
      seed = await seedMinimal(db);
    });

    function ctx(turn: number): ToolContext {
      return {
        db,
        entityId: seed.entityId,
        agentId: seed.agentId,
        jobId: seed.jobId,
        workspaces: [{ label: 'shared', path: ws }],
        checkpointsRoot: store,
        turn,
      } as unknown as ToolContext;
    }
    const opts = { approvalRules: [], onApprovalRequired: async () => {} } as never;

    /** Un sous-dépôt dans le workspace ; la commande confinée y plante le piège. */
    async function plantedSubRepo(): Promise<string> {
      const sub = join(ws, 'sub');
      await mkdir(sub);
      await writeFile(join(ws, 'a.txt'), 'a\n');
      hostGit(sub, 'init', '-q');
      await writeFile(join(sub, 'f.txt'), 'f\n');
      hostGit(sub, 'add', 'f.txt');
      hostGit(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      await confined(
        await plantScript(`execFileSync(git, ['config', 'core.fsmonitor', hook]);\n`),
        sub,
      );
      return sub;
    }

    /** La commande confinée change le sous-dépôt : le git suivant le relit. */
    async function touchSub(): Promise<void> {
      await confined(
        await plantScript(`fs.writeFileSync('sub/f.txt', 'changed ' + Date.now());\n`),
      );
    }

    it('TÉMOIN : une photo prise sur l’hôte exécute le piège du sous-dépôt', async () => {
      await plantedSubRepo();
      await snapshot(store, ws, 'one');
      await touchSub();
      await snapshot(store, ws, 'two');
      expect(existsSync(marker), 'the trap is not armed: this test would prove nothing').toBe(true);
    });

    it('la photo d’un tour par le vrai executeTool ne lance rien sur l’hôte', async () => {
      await plantedSubRepo();
      let r = await executeTool(
        fileWriteTool as never,
        { path: 'x.txt', content: '1' },
        ctx(1),
        opts,
      );
      expect(r.outcome).toBe('success');
      await touchSub();
      r = await executeTool(fileWriteTool as never, { path: 'y.txt', content: '2' }, ctx(2), opts);
      expect(r.outcome).toBe('success');
      expect(await listCheckpoints(store, ws)).toHaveLength(2);
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);

    it('le repli du constat sur l’index figé ne lance rien sur l’hôte', async () => {
      await plantedSubRepo();
      await withNodalPrograms((programs) => snapshot(store, ws, 'one', { programs }), {
        workspace: noWorkspaceSandbox,
      });
      await touchSub();
      // Le workspace n'est pas un dépôt : le constat se replie sur l'index de
      // son instantané (statusAgainstFrozenIndex), qui relit le sous-dépôt.
      const before = await snapshotGitAvant([ws], noWorkspaceSandbox, { store, workspaces: [ws] });
      expect(before.some((b) => b.frozen !== undefined)).toBe(true);
      await constatedGitWrites(before, noWorkspaceSandbox);
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);

    it('la restauration ne lance rien sur l’hôte', async () => {
      await plantedSubRepo();
      const one = await withNodalPrograms((programs) => snapshot(store, ws, 'one', { programs }), {
        workspace: noWorkspaceSandbox,
      });
      await touchSub();
      await withNodalPrograms((programs) => restoreCheckpoint(store, ws, one!.sha, programs), {
        workspace: noWorkspaceSandbox,
      });
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);
  },
);
