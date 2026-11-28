// workspace-git-hardened.test.ts — the probe of a job's first folder runs
// Nodal's git with its fixed configuration: what the folder's repository (or a
// repository nested in it) names is never executed, and the probe still
// describes the repository.
//
// The probe runs at job start, before the agent does anything, on whatever
// folder the request attached. Here the sandbox is SWITCHED OFF for the
// workspace, so git runs on the host: the case where nothing else stands
// between a planted configuration and the runner's machine.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceSandboxReader } from '@nodal-agents/sandbox';
import { probeWorkspaceGit } from '../../lib/workspace-git.ts';

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

function newRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true });
  rawGit(dir, 'init', '-q', `--initial-branch=${branch}`);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  rawGit(dir, 'add', 'a.txt');
  rawGit(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
}

/** Every program-starting key the probe's commands could reach, in one repository. */
function plant(dir: string, label: string): void {
  rawGit(dir, 'config', 'core.fsmonitor', `${planted} ${label}-fsmonitor`);
  rawGit(dir, 'config', 'filter.nodaltemoin.clean', `${planted} ${label}-clean`);
  rawGit(dir, 'config', 'filter.nodaltemoin.required', 'true');
  writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.txt filter=nodaltemoin\n');
  const hook = join(dir, '.git', 'hooks', 'post-index-change');
  writeFileSync(hook, `#!/bin/sh\n${planted} ${label}-hook\n`);
  chmodSync(hook, 0o755);
}

beforeEach(() => {
  // The LONG form of the path (a CI temp folder can be a short 8.3 name): the one git prints.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'nodal probe dépôt ')));
  marker = join(root, 'MARKER');
  const witness = join(root, 'witness.cjs');
  writeFileSync(
    witness,
    `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n');\n`,
  );
  planted = `node "${fwd(witness)}"`;
  repo = join(root, 'projet');
  newRepo(repo, 'principale');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('probeWorkspaceGit — a planted repository runs nothing, and is still described @cap:executer-une-commande/moteur', () => {
  it('the repository at the root of the folder', async () => {
    plant(repo, 'root');
    // Same size, older date: git must read the file's content to know.
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const state = await probeWorkspaceGit(repo, sandboxOff);
    expect(state?.root).toBe(fwd(repo));
    expect(state?.branch).toBe('principale');
    expect(state?.dirtyCount).toBe(1);
    expect(state?.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(existsSync(marker), 'a planted program ran on the host').toBe(false);
  });

  it('a repository nested in the folder (its child git inherits the configuration)', async () => {
    const nested = join(repo, 'nested');
    newRepo(nested, 'main');
    rawGit(repo, 'add', 'nested');
    rawGit(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'nested');
    plant(nested, 'nested');
    writeFileSync(join(nested, 'a.txt'), 'two\n');
    const state = await probeWorkspaceGit(repo, sandboxOff);
    expect(state?.root).toBe(fwd(repo));
    expect(state?.dirtyCount).toBe(1);
    expect(existsSync(marker), 'a planted program of the nested repository ran').toBe(false);
  });
});
