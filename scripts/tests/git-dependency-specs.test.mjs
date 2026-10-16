// git-dependency-specs.test.mjs — the guard that would have stopped 0.9.6 from
// reaching npm with a dependency tree that only installs where git exists.
//
// Assertions are on real results: trees written to disk the way npm lays them
// out (scopes, nested node_modules, optional deps), scanned for real.
//
// Run from the repo root: pnpm test:scripts

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isGitSpec,
  findGitDependencySpecs,
  formatGitDependencySpecs,
} from '../lib/git-dependency-specs.mjs';

describe('isGitSpec', () => {
  it.each([
    // The exact spec @whiskeysockets/baileys 6.7.23 / 6.7.24 ship.
    'git+https://github.com/whiskeysockets/libsignal-node.git',
    'git+https://github.com/whiskeysockets/libsignal-node',
    'git+ssh://git@github.com/owner/repo.git#v1.2.0',
    'git://github.com/owner/repo.git',
    'github:owner/repo',
    'gitlab:owner/repo#main',
    'bitbucket:owner/repo',
    'gist:11081aaa281',
    'https://github.com/owner/repo.git',
    'owner/repo',
    'owner/repo#semver:^1.0.0',
  ])('flags %s', (spec) => {
    expect(isGitSpec(spec)).toBe(true);
  });

  it.each([
    '6.7.23',
    '^6.0.0',
    '>=1.2.3 <2.0.0',
    '1.x || 2.x',
    'latest',
    '*',
    '',
    'npm:@scope/pkg@^1.0.0',
    'workspace:*',
    'file:../local',
    './vendor/pkg',
    '/abs/path/pkg',
    'C:\\pkgs\\x',
    'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
  ])('does not flag %s', (spec) => {
    expect(isGitSpec(spec)).toBe(false);
  });

  it('ignores a non-string value', () => {
    expect(isGitSpec(undefined)).toBe(false);
    expect(isGitSpec(42)).toBe(false);
  });
});

describe('findGitDependencySpecs', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function writePkg(dir, manifest) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  }

  it('finds a git spec declared by a scoped package nested deep in the tree (the 0.9.6 shape)', () => {
    root = mkdtempSync(join(tmpdir(), 'git-specs-'));
    const nm = join(root, 'node_modules');
    writePkg(join(nm, 'nodal-agents'), {
      name: 'nodal-agents',
      version: '0.9.6',
      dependencies: { '@whiskeysockets/baileys': '6.7.23', zod: '4.4.3' },
    });
    writePkg(join(nm, 'nodal-agents', 'node_modules', '@whiskeysockets', 'baileys'), {
      name: '@whiskeysockets/baileys',
      version: '6.7.23',
      dependencies: { libsignal: 'git+https://github.com/whiskeysockets/libsignal-node' },
      devDependencies: { tooling: 'github:owner/tooling' },
    });
    writePkg(join(nm, 'nodal-agents', 'node_modules', 'zod'), { name: 'zod', version: '4.4.3' });

    const found = findGitDependencySpecs(nm);

    // devDependencies are never installed for a dependency: not reported.
    expect(found.map(({ pkg, field, dep, spec }) => ({ pkg, field, dep, spec }))).toEqual([
      {
        pkg: '@whiskeysockets/baileys@6.7.23',
        field: 'dependencies',
        dep: 'libsignal',
        spec: 'git+https://github.com/whiskeysockets/libsignal-node',
      },
    ]);
    const report = formatGitDependencySpecs(found);
    expect(report).toContain('1 dependency needs git');
    expect(report).toContain(
      '@whiskeysockets/baileys@6.7.23 → dependencies.libsignal = "git+https://github.com/whiskeysockets/libsignal-node"',
    );
  });

  it('reports an OPTIONAL git dependency, which npm would drop in silence without git', () => {
    root = mkdtempSync(join(tmpdir(), 'git-specs-'));
    const nm = join(root, 'node_modules');
    writePkg(join(nm, 'a'), {
      name: 'a',
      version: '1.0.0',
      optionalDependencies: { b: 'github:owner/b' },
    });

    expect(findGitDependencySpecs(nm).map((f) => `${f.pkg}:${f.field}.${f.dep}`)).toEqual([
      'a@1.0.0:optionalDependencies.b',
    ]);
  });

  it('returns nothing for a tree resolved from the registry only', () => {
    root = mkdtempSync(join(tmpdir(), 'git-specs-'));
    const nm = join(root, 'node_modules');
    writePkg(join(nm, 'a'), { name: 'a', version: '1.0.0', dependencies: { b: '^2.0.0' } });
    writePkg(join(nm, '@s', 'c'), { name: '@s/c', version: '3.0.0', dependencies: { d: '1.x' } });
    mkdirSync(join(nm, '.bin'));

    const found = findGitDependencySpecs(nm);
    expect(found).toEqual([]);
    expect(formatGitDependencySpecs(found)).toBe('');
  });

  it('fails loud when there is no tree to scan, instead of passing on nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'git-specs-'));
    expect(() => findGitDependencySpecs(join(root, 'node_modules'))).toThrow(
      /nothing was installed/,
    );
  });
});
