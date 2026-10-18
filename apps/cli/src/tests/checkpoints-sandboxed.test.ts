// checkpoints-sandboxed.test.ts — `nodal-agents checkpoints restore` ne doit
// rien exécuter sur l'hôte de ce qu'une commande confinée a planté dans le
// workspace (#628, audit P1-2, décision A du 16/10). Mesuré le 16/10 : un
// sous-dépôt imbriqué fait exécuter sa config (`core.fsmonitor`) par la
// restauration (son instantané de sécurité, puis le `checkout`).
//
// Même méthode que packages/tools/src/tests/git-sandboxed.test.ts : le piège
// est posé par une commande confinée, la commande plantée écrit un marqueur
// hors de toute racine du conteneur, et un TÉMOIN (la même restauration, git
// sur l'hôte) prouve qu'il est armé.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSandbox,
  JobProcessScope,
  mxcBackend,
  nodalProgramsSandbox,
  withNodalPrograms,
} from '@nodal-agents/sandbox';
import { restoreCheckpoint, snapshot } from '@nodal-agents/checkpoints';
import { resolveGitBinary } from '@nodal-agents/shared/git-binary';
import { runCheckpointsRestore } from '../commands/checkpoints';

const fwd = (p: string): string => p.split('\\').join('/');

// La config vitest du CLI n'a pas le setupFile de test-kit : les scripts et le
// Node du courtier iraient sous le VRAI ~/.nodalai/sandbox. Redirigés ici,
// avant le premier appel au bac à sable (sandboxHostDir est lu à l'usage).
process.env['NODALAI_SANDBOX_DIR'] ??= mkdtempSync(join(tmpdir(), 'nodal-cpsb-sandbox-'));

const available =
  process.platform === 'win32' && (await nodalProgramsSandbox().status()).state === 'available';

const jobSandbox = createSandbox(mxcBackend(undefined, 'deny-all'), { log: () => {} });

let root = '';
let ws = '';
let store = '';
let marker = '';
let hook = '';
let git = '';
const savedStore = process.env['NODALAI_CHECKPOINTS_ROOT'];

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
  const scope = new JobProcessScope('checkpoints-sandboxed-plant', jobSandbox);
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

/** Un sous-dépôt piégé, une photo, puis la commande confinée change l'arbre. */
async function plantedAndSnapshotted(): Promise<string> {
  const sub = join(ws, 'sub');
  await mkdir(sub);
  await writeFile(join(ws, 'a.txt'), 'a\n');
  hostGit(sub, 'init', '-q');
  await writeFile(join(sub, 'f.txt'), 'f\n');
  hostGit(sub, 'add', 'f.txt');
  hostGit(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  await confined(`execFileSync(git, ['config', 'core.fsmonitor', hook]);\n`, sub);
  const one = await withNodalPrograms((programs) => snapshot(store, ws, 'one', { programs }));
  await confined(
    `fs.writeFileSync('sub/f.txt', 'changed ' + Date.now());\n` +
      `fs.writeFileSync('a.txt', 'changed ' + Date.now());\n`,
  );
  return one!.sha;
}

beforeAll(async () => {
  git = (await resolveGitBinary()) ?? '';
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nodal-cpsb-')));
  ws = join(root, 'ws');
  store = join(root, 'checkpoints');
  process.env['NODALAI_CHECKPOINTS_ROOT'] = store;
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
  'checkpoints restore runs git in the sandbox: a planted sub-repository never runs on the host @cap:executer-une-commande/moteur (Windows, MXC available)',
  () => {
    it('TÉMOIN : la même restauration, git sur l’hôte, exécute le piège', async () => {
      const sha = await plantedAndSnapshotted();
      await restoreCheckpoint(store, ws, sha);
      expect(existsSync(marker), 'the trap is not armed: this test would prove nothing').toBe(true);
    }, 120_000);

    it('la commande du CLI restaure sans rien lancer sur l’hôte', async () => {
      const sha = await plantedAndSnapshotted();
      await runCheckpointsRestore(sha.slice(0, 8), ws);
      expect(existsSync(marker), 'the planted command ran on the HOST').toBe(false);
    }, 120_000);
  },
);
