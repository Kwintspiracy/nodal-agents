// git-constat-hardened.test.ts — the write audit reads a repository whose
// configuration (and a nested repository's) names programs: it still sees
// what the call wrote, and none of those programs runs.
//
// The sandbox is SWITCHED OFF for the workspace, so the audit's git runs on
// the host: nothing but the launcher of Nodal's own git
// (@nodal-agents/shared/internal-git) stands between the planted
// configuration and the runner's machine.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceSandboxReader } from '@nodal-agents/sandbox';
import { constatedGitWrites, snapshotGitAvant } from '../verification/git-constat';

const fwd = (p: string): string => p.split('\\').join('/');
const sandboxOff: WorkspaceSandboxReader = async () => ({
  enabled: false,
  folders: { added: [], removed: [] },
});

let root = '';
let repo = '';
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
  rawGit(dir, 'config', 'filter.nodaltemoin.required', 'true');
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.txt filter=nodaltemoin\n');
  const hook = join(dir, '.git', 'hooks', 'post-index-change');
  writeFileSync(hook, `#!/bin/sh\n${planted} ${label}-hook\n`);
  chmodSync(hook, 0o755);
}

beforeEach(async () => {
  // The LONG form of the path (a CI temp folder can be a short 8.3 name): the one git prints.
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal constat dépôt ')));
  marker = join(root, 'MARKER');
  const witness = join(root, 'witness.cjs');
  writeFileSync(
    witness,
    `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`,
  );
  planted = `node "${fwd(witness)}"`;
  repo = join(root, 'projet');
  newRepo(repo);
  const nested = join(repo, 'nested');
  newRepo(nested);
  rawGit(repo, 'add', 'nested');
  rawGit(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'nested');
  plant(repo, 'root');
  plant(nested, 'nested');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the write audit over planted repositories @cap:verifier-un-livrable/moteur', () => {
  it('sees the writes of the call, and runs no planted program', async () => {
    const before = await snapshotGitAvant([repo], sandboxOff);
    expect(before.length).toBe(1);
    // What "the call" writes: a new file, a same-size change, a nested change.
    writeFileSync(join(repo, 'nouveau.txt'), 'écrit pendant l’appel\n');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'nested', 'a.txt'), 'two\n');
    const after = await constatedGitWrites(before, sandboxOff);
    const paths = after.writes.map((w) => w.path);
    expect(paths).toContain(fwd(join(repo, 'nouveau.txt')));
    expect(paths).toContain(fwd(join(repo, 'a.txt')));
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '', 'a planted program ran').toBe(
      '',
    );
  }, 60_000);
});
