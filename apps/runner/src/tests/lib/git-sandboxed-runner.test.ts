// git-sandboxed-runner.test.ts — les git que le RUNNER lance sur un workspace
// (la sonde du bloc git du prompt, la photo d'un tour de runtime CLI) ne
// doivent rien exécuter sur l'hôte de ce qu'une commande confinée y a planté
// (#628, audit P1-2, décision A du 16/10). Même méthode que
// packages/tools/src/tests/git-sandboxed.test.ts : le piège est posé par une
// commande confinée, la commande plantée écrit un marqueur hors de toute racine
// du conteneur, et un TÉMOIN (même piège, git sur l'hôte) prouve qu'il est armé.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _setNodalProgramsSandboxForTests,
  createSandbox,
  hostPrograms,
  JobProcessScope,
  mxcBackend,
  nodalProgramsSandbox,
} from '@nodal-agents/sandbox';
import { listCheckpoints, snapshot } from '@nodal-agents/checkpoints';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { resolveGitBinary } from '@nodal-agents/shared/git-binary';
import { probeWorkspaceGit } from '../../lib/workspace-git';
import { takeCliTurnCheckpoints } from '../../cli-runtime/run-job';

const fwd = (p: string): string => p.split('\\').join('/');

// Ce fichier porte sur le bac à sable : il réactive celui du système, que le
// setupFile du runner remplace par l'hôte pour le reste de la suite.
_setNodalProgramsSandboxForTests(undefined);

const available =
  process.platform === 'win32' && (await nodalProgramsSandbox().status()).state === 'available';

const jobSandbox = createSandbox(mxcBackend(undefined, 'deny-all'), { log: () => {} });

let root = '';
let ws = '';
let marker = '';
let hook = '';
let git = '';

async function confined(body: string, cwd: string = ws): Promise<void> {
  const script = join(root, `plant-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(
    script,
    `const { execFileSync } = require('child_process');\n` +
      `const fs = require('fs');\n` +
      `const git = ${JSON.stringify(git)};\n` +
      `const hook = ${JSON.stringify(`node "${fwd(hook)}"`)};\n` +
      body,
  );
  const scope = new JobProcessScope('git-sandboxed-runner-plant', jobSandbox);
  try {
    const env: Record<string, string | undefined> = {};
    for (const n of ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'LOCALAPPDATA', 'USERPROFILE']) {
      env[n] = process.env[n];
    }
    const c = await scope.container([ws], env);
    const p = await c.start({ target: { file: process.execPath, args: [script] }, cwd, env });
    let err = '';
    p.stderr?.on('data', (d: Buffer) => (err += String(d)));
    expect(await p.done, err).toEqual({ kind: 'exit', exitCode: 0 });
  } finally {
    await scope.close();
  }
}

function hostGit(cwd: string, ...args: string[]): void {
  execFileSync(git, args, { cwd, stdio: 'ignore' });
}

beforeAll(async () => {
  git = (await resolveGitBinary()) ?? '';
});

// Le magasin des photos du runner (checkpointsRoot) : un temporaire, jamais le
// vrai ~/.nodalai/checkpoints.
const savedStore = process.env['NODALAI_CHECKPOINTS_ROOT'];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nodal-gitsbr-')));
  process.env['NODALAI_CHECKPOINTS_ROOT'] = join(root, 'checkpoints');
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  marker = join(root, 'HOST-MARKER');
  hook = join(root, 'hook.cjs');
  await writeFile(hook, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran');\n`);
});

afterEach(async () => {
  if (savedStore === undefined) delete process.env['NODALAI_CHECKPOINTS_ROOT'];
  else process.env['NODALAI_CHECKPOINTS_ROOT'] = savedStore;
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* un conteneur qui tarde à lâcher un fichier : laissé à l'OS */
  }
});

describe.runIf(available)(
  'probeWorkspaceGit runs git in the sandbox: a planted core.fsmonitor and filter never run on the host @cap:executer-une-commande/moteur (Windows, MXC available)',
  () => {
    async function plantedRepo(): Promise<void> {
      hostGit(ws, 'init', '-q');
      await writeFile(join(ws, 'a.txt'), 'one\n');
      hostGit(ws, 'add', 'a.txt');
      hostGit(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      await confined(
        `execFileSync(git, ['config', 'core.fsmonitor', hook]);\n` +
          `execFileSync(git, ['config', 'filter.evil.clean', hook]);\n` +
          `fs.writeFileSync('.gitattributes', '*.txt filter=evil\\n');\n` +
          `fs.writeFileSync('a.txt', 'two\\n');\n`,
      );
    }

    it('TÉMOIN : git status sur l’hôte exécute le piège', async () => {
      await plantedRepo();
      await hostPrograms.execFile(git, ['status', '--porcelain'], {
        cwd: ws,
        writableRoots: [],
        readableRoots: [],
      });
      expect(existsSync(marker), 'the trap is not armed: this test would prove nothing').toBe(true);
    });

    it('la sonde décrit le dépôt sans rien lancer sur l’hôte', async () => {
      await plantedRepo();
      const state = await probeWorkspaceGit(ws);
      expect(state?.root).toBe(fwd(ws));
      expect(state?.dirtyCount).toBeGreaterThan(0);
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);
  },
);

describe.runIf(available)(
  'takeCliTurnCheckpoints runs git in the sandbox: a planted sub-repository never runs on the host @cap:executer-une-commande/moteur (Windows, MXC available)',
  () => {
    let db: TestDb;
    let seed: Awaited<ReturnType<typeof seedMinimal>>;

    beforeAll(async () => {
      db = (await spinUpTestDb()).db;
      seed = await seedMinimal(db);
    });

    async function plantedSubRepo(): Promise<void> {
      const sub = join(ws, 'sub');
      await mkdir(sub);
      await writeFile(join(ws, 'a.txt'), 'a\n');
      hostGit(sub, 'init', '-q');
      await writeFile(join(sub, 'f.txt'), 'f\n');
      hostGit(sub, 'add', 'f.txt');
      hostGit(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      await confined(`execFileSync(git, ['config', 'core.fsmonitor', hook]);\n`, sub);
    }

    // Le sous-dépôt ET un fichier du workspace : sans changement de l'arbre
    // parent (un gitlink ne bouge qu'au commit), la photo suivante n'a rien à
    // enregistrer.
    const touchSub = (): Promise<void> =>
      confined(
        `fs.writeFileSync('sub/f.txt', 'changed ' + Date.now());\n` +
          `fs.writeFileSync('a.txt', 'changed ' + Date.now());\n`,
      );

    it('TÉMOIN : une photo prise sur l’hôte exécute le piège du sous-dépôt', async () => {
      await plantedSubRepo();
      const store = join(root, 'checkpoints');
      await snapshot(store, ws, 'one');
      await touchSub();
      await snapshot(store, ws, 'two');
      expect(existsSync(marker), 'the trap is not armed: this test would prove nothing').toBe(true);
    });

    it('la photo de deux tours ne lance rien sur l’hôte', async () => {
      await plantedSubRepo();
      const store = join(root, 'checkpoints');
      const workspaces = [{ label: 'shared', path: ws }];
      await takeCliTurnCheckpoints(db, seed.jobId, workspaces, 1);
      await touchSub();
      await takeCliTurnCheckpoints(db, seed.jobId, workspaces, 2);
      expect(await listCheckpoints(store, ws)).toHaveLength(2);
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);
  },
);
