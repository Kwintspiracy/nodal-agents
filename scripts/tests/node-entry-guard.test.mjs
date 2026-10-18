// node-entry-guard.test.mjs — every product entry carries the Node guard, and the
// minimum Node is stated the same everywhere (#628).
//
// Run from the repo root: pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packEngines } from '../lib/pack-engines.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(resolve(repoRoot, p), 'utf-8');

// The first import statement of a source file (comments and the shebang skipped).
function firstImport(source) {
  const match = /^import\s[^;]*;/m.exec(source);
  return match ? match[0] : null;
}

const GUARD = "import '@nodal-agents/shared/node-guard';";
const ENTRIES = ['apps/cli/src/index.ts', 'apps/runner/src/server.ts'];

describe('Node guard on every product entry', () => {
  it.each(ENTRIES)('%s imports the guard before anything else', (entry) => {
    expect(firstImport(read(entry))).toBe(GUARD);
  });

  it('the runner build has no entry beyond the guarded server.ts', () => {
    const entries = [...read('apps/runner/build.mjs').matchAll(/entryPoints:\s*\[([^\]]*)\]/g)];
    expect(entries.map((m) => m[1].match(/src\/[\w./-]+/g))).toEqual([['src/server.ts']]);
  });
});

describe('minimum Node stated once', () => {
  it('the root package.json requires Node >=24', () => {
    expect(JSON.parse(read('package.json')).engines).toEqual({ node: '>=24' });
  });

  it('the pack manifest build-pack.mjs writes carries the same engines', () => {
    expect(packEngines(repoRoot)).toEqual({ node: '>=24' });
    expect(read('scripts/build-pack.mjs')).toContain('engines: packEngines(repoRoot),');
  });

  it('the badge and the shared constant agree with it', () => {
    expect(read('README.md')).toContain('badge/node-24%2B-');
    expect(read('packages/shared/src/node-version.ts')).toContain('MINIMUM_NODE_MAJOR = 24;');
  });
});
