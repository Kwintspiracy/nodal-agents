// stack.test.ts — à quelle version et à quel commit une mesure est rattachée.
//
// Une ligne sans version ni commit ne se compare à rien. Le commit est lu dans
// `.git` sans lancer git (le banc peut viser la stack d'un autre dossier) : ces
// cas couvrent les quatre formes que prend un dépôt sur le disque.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { obsidianVaults } from '../scenarios';
import { readStackCommit, readStackVersion } from '../stack';
import { redactHome } from '../redact';
import { createArgs, wrapperScript } from '../schedule';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'wf-stack-'));
  mkdirSync(join(d, '.git', 'refs', 'heads'), { recursive: true });
  return d;
}

describe('the stack a measure belongs to', () => {
  it('reads a detached HEAD', () => {
    const d = repo();
    writeFileSync(join(d, '.git', 'HEAD'), `${SHA}\n`);
    expect(readStackCommit(d)).toBe(SHA);
  });

  it('reads a branch through its ref file, then through packed-refs', () => {
    const d = repo();
    writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(d, '.git', 'packed-refs'), `# pack-refs\n${SHA} refs/heads/main\n`);
    expect(readStackCommit(d)).toBe(SHA);
    const loose = 'fedcba9876543210fedcba9876543210fedcba98';
    writeFileSync(join(d, '.git', 'refs', 'heads', 'main'), `${loose}\n`);
    expect(readStackCommit(d)).toBe(loose);
  });

  it('follows a worktree .git file to its HEAD and to the common refs', () => {
    const main = repo();
    writeFileSync(join(main, '.git', 'refs', 'heads', 'feat'), `${SHA}\n`);
    const wtGit = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/feat\n');
    writeFileSync(join(wtGit, 'commondir'), '../..\n');
    const wt = mkdtempSync(join(tmpdir(), 'wf-wt-'));
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(readStackCommit(wt)).toBe(SHA);
  });

  it('says unknown rather than guessing when there is no repository', () => {
    expect(readStackCommit(mkdtempSync(join(tmpdir(), 'wf-none-')))).toBeNull();
  });

  it('reads the version the CLI package serves', () => {
    const d = mkdtempSync(join(tmpdir(), 'wf-ver-'));
    mkdirSync(join(d, 'apps', 'cli'), { recursive: true });
    writeFileSync(
      join(d, 'apps', 'cli', 'package.json'),
      '{"name":"nodal-agents","version":"0.9.4"}',
    );
    expect(readStackVersion(d)).toBe('0.9.4');
  });
});

describe('where the vault is', () => {
  it('a vault is a workspace folder that holds .obsidian — no path is known in advance', () => {
    const vault = mkdtempSync(join(tmpdir(), 'wf-vault-'));
    mkdirSync(join(vault, '.obsidian'));
    const plain = mkdtempSync(join(tmpdir(), 'wf-plain-'));
    expect(obsidianVaults([plain, vault])).toEqual([vault]);
    expect(obsidianVaults([plain])).toEqual([]);
  });
});

describe('what a fixture may carry into a public repository', () => {
  it('replaces the home folder in every spelling, JSON-escaped ones included', () => {
    const home = 'C:\\Users\\alice';
    const text = JSON.stringify({
      a: 'C:\\Users\\alice\\.nodalai\\x.csv',
      b: 'c:/users/alice/doc',
      c: JSON.stringify({ p: 'C:\\Users\\alice\\y' }),
    });
    const out = redactHome(text, home);
    expect(out).not.toMatch(/alice/i);
    expect(JSON.parse(out)).toEqual({
      a: '~\\.nodalai\\x.csv',
      b: '~/doc',
      c: JSON.stringify({ p: '~\\y' }),
    });
  });
});

describe('the nightly task', () => {
  it('runs the bench from the repository, marked scheduled, its output appended to a log', () => {
    expect(wrapperScript('D:\\x y\\NodalAI', 'C:\\h\\workflows.log').split('\r\n')).toEqual([
      '@echo off',
      'rem Nodal-Agents workflow bench, launched by the scheduled task. See packages/bench/src/workflows/schedule.ts',
      'cd /d "D:\\x y\\NodalAI"',
      'echo ==== %DATE% %TIME% >> "C:\\h\\workflows.log"',
      'call pnpm bench:workflows --scheduled >> "C:\\h\\workflows.log" 2>&1',
      '',
    ]);
  });

  it('is daily at 03:00 by default, quoted for a path with spaces, and refuses a bad hour', () => {
    expect(createArgs('03:00', 'C:\\Users\\Jane Doe\\.nodalai\\bench\\run-workflows.cmd')).toEqual([
      '/Create',
      '/TN',
      '"Nodal-Agents workflow bench"',
      '/TR',
      '"\\"C:\\Users\\Jane Doe\\.nodalai\\bench\\run-workflows.cmd\\""',
      '/SC',
      'DAILY',
      '/ST',
      '03:00',
      '/F',
    ]);
    expect(() => createArgs('3h', 'C:\\a.cmd')).toThrow('--at wants HH:MM');
  });
});
