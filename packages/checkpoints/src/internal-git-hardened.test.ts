// internal-git-hardened.test.ts — checkpoints keep working on a workspace whose
// repositories name programs, and none of those programs runs.
//
// Every git of this package goes through the launcher of Nodal's own git
// (@nodal-agents/shared/internal-git). Here, on the HOST (no programs given:
// the path every caller takes when the sandbox is off or absent), a workspace
// carries a repository at its root and one nested in it, each naming a
// file-system monitor, a hook and a filter. A real history is taken, shown,
// diffed and restored; the marker file stays absent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffFile,
  freezeSnapshotIndex,
  listCheckpoints,
  releaseFrozenIndex,
  restoreCheckpoint,
  snapshot,
  statusAgainstFrozenIndex,
} from './checkpoints';

const fwd = (p: string): string => p.split('\\').join('/');

let root = '';
let ws = '';
let store = '';
let marker = '';
let planted = '';

function rawGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function newRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  rawGit(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  rawGit(dir, 'add', 'a.txt');
  rawGit(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
}

function plant(dir: string, label: string): void {
  rawGit(dir, 'config', 'core.fsmonitor', `${planted} ${label}-fsmonitor`);
  rawGit(dir, 'config', 'filter.nodaltemoin.clean', `${planted} ${label}-clean`);
  rawGit(dir, 'config', 'filter.nodaltemoin.smudge', `${planted} ${label}-smudge`);
  rawGit(dir, 'config', 'filter.nodaltemoin.required', 'true');
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.txt filter=nodaltemoin\n');
  for (const event of ['post-index-change', 'post-checkout']) {
    const hook = join(dir, '.git', 'hooks', event);
    writeFileSync(hook, `#!/bin/sh\n${planted} ${label}-${event}\n`);
    chmodSync(hook, 0o755);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal checkpoints dépôt '));
  ws = join(root, 'ws');
  store = join(root, 'checkpoints');
  marker = join(root, 'MARKER');
  const witness = join(root, 'witness.cjs');
  writeFileSync(
    witness,
    `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`,
  );
  planted = `node "${fwd(witness)}"`;
  newRepo(ws);
  const nested = join(ws, 'nested');
  newRepo(nested);
  rawGit(ws, 'add', 'nested');
  rawGit(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'nested');
  // The worktree's own attributes name the filter too: they apply to the
  // store's git, which reads the workspace as its work tree.
  writeFileSync(join(ws, '.gitattributes'), '*.txt filter=nodaltemoin\n');
  plant(ws, 'root');
  plant(nested, 'nested');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ran = (): string => (existsSync(marker) ? readFileSync(marker, 'utf8') : '');

describe('checkpoints over planted repositories — a real history, nothing run @cap:executer-une-commande/moteur', () => {
  it('snapshot, status, diff and restore give their real answers; no planted program runs', async () => {
    const one = await snapshot(store, ws, 'one');
    expect(one).not.toBeNull();

    // Same size: the nested repository's git has to read the content.
    writeFileSync(join(ws, 'a.txt'), 'two\n');
    writeFileSync(join(ws, 'nested', 'a.txt'), 'two\n');
    const two = await snapshot(store, ws, 'two');
    expect(two).not.toBeNull();
    expect((await listCheckpoints(store, ws)).map((c) => c.sha)).toEqual([two!.sha, one!.sha]);

    // The bytes stored are the bytes on disk: no filter ran over them.
    const stored = execFileSync(
      'git',
      ['--git-dir', join(store, 'store'), 'show', `${two!.sha}:a.txt`],
      {
        encoding: 'utf8',
      },
    );
    expect(stored).toBe('two\n');

    // The dashboard's diff of one file between the two.
    const diff = await diffFile(store, ws, one!.sha, two!.sha, 'a.txt');
    expect(diff.kind).toBe('diff');
    if (diff.kind === 'diff') expect(diff.text).toMatch(/^-one$[\s\S]*^\+two$/m);

    // The write audit's status against the frozen index of the last snapshot.
    writeFileSync(join(ws, 'b.txt'), 'new\n');
    const frozen = await freezeSnapshotIndex(store, ws);
    expect(frozen.kind).toBe('frozen');
    if (frozen.kind === 'frozen') {
      const status = await statusAgainstFrozenIndex(store, ws, frozen.indexFile);
      await releaseFrozenIndex(frozen.indexFile);
      expect(status.kind).toBe('status');
      if (status.kind === 'status') expect(status.stdout).toContain('?? b.txt');
    }

    // Back to the first one.
    await restoreCheckpoint(store, ws, one!.sha);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('one\n');

    expect(ran(), 'a planted program ran on the host').toBe('');
  }, 120_000);
});
