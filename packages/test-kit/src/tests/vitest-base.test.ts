// vitest-base.test.ts — every package that runs vitest runs it with the shared
// base (`vitest.base.ts`): same timeouts, same environment, same exclusions.
//
// The defect this prevents: a per-package `vitest.config.ts` SHADOWS the root
// one completely, so apps/cli, once given a config, silently went back to
// vitest's 5 s per-test default and Windows CI went red on a test that spawns
// the CLI through tsx (run 39158880706, "Test timed out in 5000ms"). The rule
// is structural, not numeric: the CONFIG THAT APPLIES to a package (its own, or
// the nearest one above it — vitest searches up the tree) must merge the base.
// The numbers, and why they are what they are, live in the base alone.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
];
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', '.claude', '.git', 'fixtures']);

function configIn(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The config vitest applies to `dir`: its own, else the nearest above, up to `root`. */
function appliedConfig(dir: string, root: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    const found = configIn(d);
    if (found) return found;
    if (d === root || dirname(d) === d) return null;
  }
}

function vitestPackages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (readdirSyncOrNull(p) !== null) vitestPackages(p, out);
  }
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    const test = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: { test?: string } }).scripts
      ?.test;
    if (test && /\bvitest\b/.test(test)) out.push(dir);
  }
  return out;
}

function readdirSyncOrNull(p: string): string[] | null {
  try {
    return readdirSync(p);
  } catch {
    return null;
  }
}

/** Every way a package's applied vitest config fails to merge the base. */
export function vitestConfigProblems(root: string): string[] {
  const problems: string[] = [];
  const merged = new Map<string, string | null>();
  for (const dir of vitestPackages(root)) {
    const where = relative(root, dir).split(sep).join('/') || '.';
    const cfg = appliedConfig(dir, root);
    if (!cfg) {
      problems.push(`${where}: runs vitest and no vitest config applies to it`);
      continue;
    }
    if (!merged.has(cfg)) {
      const text = readFileSync(cfg, 'utf8');
      const ok =
        /from\s+['"][^'"]*vitest\.base(\.ts)?['"]/.test(text) && /\bmergeConfig\(/.test(text);
      merged.set(
        cfg,
        ok
          ? null
          : `${relative(root, cfg).split(sep).join('/')}: does not mergeConfig the shared vitest.base`,
      );
    }
    const bad = merged.get(cfg);
    if (bad) problems.push(`${where}: ${bad}`);
  }
  return [...new Set(problems)];
}

describe('vitest base: the checker @cap:executer-une-commande/moteur', () => {
  let tmp: string;
  const write = (rel: string, content: string) => {
    const p = join(tmp, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const pkg = (rel: string) =>
    write(`${rel}/package.json`, JSON.stringify({ scripts: { test: 'vitest run' } }));
  const GOOD =
    "import { baseConfig } from './vitest.base.ts';\nexport default mergeConfig(baseConfig, {});\n";

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vitest-base-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('is red on a package that runs vitest with no config at or above it', () => {
    pkg('packages/a');
    expect(vitestConfigProblems(tmp)).toEqual([
      'packages/a: runs vitest and no vitest config applies to it',
    ]);
  });

  it('is red on a config that does not merge the base', () => {
    write('vitest.config.ts', GOOD);
    write('packages/b/vitest.config.ts', 'export default { test: { testTimeout: 60_000 } };\n');
    pkg('packages/b');
    expect(vitestConfigProblems(tmp)).toEqual([
      'packages/b: packages/b/vitest.config.ts: does not mergeConfig the shared vitest.base',
    ]);
  });

  it('is green when the nearest config merges the base, own or inherited', () => {
    write('packages/b/vitest.config.ts', GOOD);
    write(
      'packages/a/package.json',
      JSON.stringify({ scripts: { test: 'vitest run --passWithNoTests' } }),
    );
    expect(vitestConfigProblems(tmp)).toEqual([]);
  });

  it('ignores a package whose test script does not run vitest', () => {
    write('packages/c/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(vitestConfigProblems(tmp)).toEqual([]);
  });
});

describe('vitest base: this repository @cap:executer-une-commande/moteur', () => {
  const root = join(__dirname, '..', '..', '..', '..');

  it('every package that runs vitest runs it with the shared base', () => {
    expect(vitestConfigProblems(root)).toEqual([]);
  });

  it('the base carries a timeout above vitest’s 5 s default, for tests and hooks', async () => {
    // Imported through a computed path: the base lives at the repository root,
    // outside this package's tsconfig rootDir.
    const base = (await import(
      /* @vite-ignore */ pathToFileURL(join(root, 'vitest.base.ts')).href
    )) as {
      TEST_TIMEOUT_MS: number;
      baseConfig: { test?: { testTimeout?: number; hookTimeout?: number } };
    };
    const { baseConfig, TEST_TIMEOUT_MS } = base;
    expect(TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(baseConfig.test?.testTimeout).toBe(TEST_TIMEOUT_MS);
    expect(baseConfig.test?.hookTimeout).toBe(TEST_TIMEOUT_MS);
  });
});
