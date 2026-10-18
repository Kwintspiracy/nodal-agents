// vitest-base.test.ts — every package that runs vitest has its OWN vitest
// config, and that config merges the shared base (`vitest.base.ts`) FIRST: same
// timeouts, same environment, same exclusions.
//
// The defect this prevents: a per-package `vitest.config.ts` SHADOWS everything
// else, so apps/cli, once given a config, silently went back to vitest's 5 s
// per-test default and Windows CI went red on a test that spawns the CLI through
// tsx (run 39158880706, "Test timed out in 5000ms"). Packages without a config
// happen to inherit the root one today because vitest looks in parent
// directories; nothing here relies on that, so every package carries its own.
//
// The check READS the config as TypeScript (compiler API), not as text: the
// default export must be a `mergeConfig(...)` call whose first argument is the
// binding imported from `vitest.base`. Importing the base and merging something
// else first (`mergeConfig(defineConfig({ ... }), baseConfig)`) is red.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Every extension vitest (and vite) accepts for a config file.
const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const VITEST_CONFIGS = EXTENSIONS.map((e) => `vitest.config.${e}`);
const VITE_CONFIGS = EXTENSIONS.map((e) => `vite.config.${e}`);
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', '.claude', '.git', 'fixtures']);

function listDir(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function vitestPackages(dir: string, out: string[] = []): string[] {
  const names = listDir(dir) ?? [];
  if (names.includes('package.json')) {
    const test = (
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: { test?: string };
      }
    ).scripts?.test;
    if (test && /\bvitest\b/.test(test)) out.push(dir);
  }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (listDir(p) !== null) vitestPackages(p, out);
  }
  return out;
}

/**
 * Why `source` is not `mergeConfig(<baseConfig imported from vitest.base>, ...)`
 * as its default export, or null when it is.
 */
export function baseMergeProblem(source: string): string | null {
  const file = ts.createSourceFile('vitest.config.ts', source, ts.ScriptTarget.Latest, true);
  let baseLocal: string | null = null;
  let mergeLocal: string | null = null;
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (/(^|\/)vitest\.base(\.ts)?$/.test(from) && imported === 'baseConfig') {
        baseLocal = el.name.text;
      }
      if (from === 'vitest/config' && imported === 'mergeConfig') mergeLocal = el.name.text;
    }
  }
  if (baseLocal === null) return 'does not import baseConfig from vitest.base';
  if (mergeLocal === null) return 'does not import mergeConfig from vitest/config';
  const exported = file.statements.find((st): st is ts.ExportAssignment =>
    ts.isExportAssignment(st),
  );
  if (!exported || exported.isExportEquals) return 'has no default export';
  const call = exported.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== mergeLocal
  ) {
    return 'default export is not a mergeConfig call';
  }
  const first = call.arguments[0];
  if (!first || !ts.isIdentifier(first) || first.text !== baseLocal) {
    return 'mergeConfig first argument is not the imported baseConfig';
  }
  return null;
}

/** Every way a package that runs vitest fails the rule. */
export function vitestConfigProblems(root: string): string[] {
  const problems: string[] = [];
  for (const dir of vitestPackages(root)) {
    const where = relative(root, dir).split(sep).join('/') || '.';
    const names = listDir(dir) ?? [];
    const configs = VITEST_CONFIGS.filter((n) => names.includes(n));
    for (const stray of VITE_CONFIGS.filter((n) => names.includes(n))) {
      problems.push(`${where}: ${stray} would also be picked up; vitest takes vitest.config only`);
    }
    if (configs.length === 0) {
      problems.push(`${where}: runs vitest and has no vitest.config of its own`);
      continue;
    }
    if (configs.length > 1) {
      problems.push(`${where}: more than one vitest config (${configs.join(', ')})`);
      continue;
    }
    const why = baseMergeProblem(readFileSync(join(dir, configs[0]!), 'utf8'));
    if (why) problems.push(`${where}: ${configs[0]} ${why}`);
  }
  return problems;
}

/** A throw-away repository tree, one per test: no test reads another's leftovers. */
function problemsOf(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), 'vitest-base-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    return vitestConfigProblems(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PKG = JSON.stringify({ scripts: { test: 'vitest run' } });
const IMPORTS =
  "import { mergeConfig, defineConfig } from 'vitest/config';\nimport { baseConfig } from '../../vitest.base.ts';\n";
const GOOD = `${IMPORTS}export default mergeConfig(baseConfig, defineConfig({}));\n`;

describe('vitest base: the checker @cap:executer-une-commande/moteur', () => {
  it('is green on a package whose own config merges the base first', () => {
    expect(
      problemsOf({ 'packages/a/package.json': PKG, 'packages/a/vitest.config.ts': GOOD }),
    ).toEqual([]);
  });

  it('is red on a package with no config of its own, even when a parent has one', () => {
    expect(problemsOf({ 'vitest.config.ts': GOOD, 'packages/a/package.json': PKG })).toEqual([
      'packages/a: runs vitest and has no vitest.config of its own',
    ]);
  });

  it('is red on a config that does not import the base at all', () => {
    expect(
      problemsOf({
        'packages/a/package.json': PKG,
        'packages/a/vitest.config.ts': 'export default { test: { testTimeout: 60_000 } };\n',
      }),
    ).toEqual(['packages/a: vitest.config.ts does not import baseConfig from vitest.base']);
  });

  it('is red when the base is imported but is not what mergeConfig takes first', () => {
    const swapped = `${IMPORTS}export default mergeConfig(defineConfig({ test: { testTimeout: 1000 } }), baseConfig);\n`;
    const unused = `${IMPORTS}export default mergeConfig({ test: { testTimeout: 1000 } }, {});\nvoid baseConfig;\n`;
    for (const cfg of [swapped, unused]) {
      expect(
        problemsOf({ 'packages/a/package.json': PKG, 'packages/a/vitest.config.ts': cfg }),
      ).toEqual([
        'packages/a: vitest.config.ts mergeConfig first argument is not the imported baseConfig',
      ]);
    }
  });

  it('is red on a default export that is not a mergeConfig call', () => {
    const plain = `${IMPORTS}void mergeConfig;\nvoid defineConfig;\nexport default baseConfig;\n`;
    expect(
      problemsOf({ 'packages/a/package.json': PKG, 'packages/a/vitest.config.ts': plain }),
    ).toEqual(['packages/a: vitest.config.ts default export is not a mergeConfig call']);
  });

  it('accepts every extension vitest accepts', () => {
    for (const ext of ['mts', 'cts', 'js', 'mjs', 'cjs']) {
      expect(
        problemsOf({ 'packages/a/package.json': PKG, [`packages/a/vitest.config.${ext}`]: GOOD }),
      ).toEqual([]);
    }
  });

  it('is red on a vite.config next to a good vitest config, in any extension', () => {
    for (const ext of ['ts', 'cjs', 'mts']) {
      expect(
        problemsOf({
          'packages/a/package.json': PKG,
          'packages/a/vitest.config.ts': GOOD,
          [`packages/a/vite.config.${ext}`]: 'export default {};\n',
        }),
      ).toEqual([
        `packages/a: vite.config.${ext} would also be picked up; vitest takes vitest.config only`,
      ]);
    }
  });

  it('is red on two vitest configs', () => {
    expect(
      problemsOf({
        'packages/a/package.json': PKG,
        'packages/a/vitest.config.ts': GOOD,
        'packages/a/vitest.config.mjs': GOOD,
      }),
    ).toEqual(['packages/a: more than one vitest config (vitest.config.ts, vitest.config.mjs)']);
  });

  it('ignores a package whose test script does not run vitest', () => {
    expect(
      problemsOf({
        'packages/c/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      }),
    ).toEqual([]);
  });
});

describe('vitest base: this repository @cap:executer-une-commande/moteur', () => {
  const root = join(__dirname, '..', '..', '..', '..');

  it('every package that runs vitest has its own config merging the shared base first', () => {
    expect(vitestConfigProblems(root)).toEqual([]);
  });

  it('the base carries a timeout above vitest default of 5 s, for tests and hooks', async () => {
    // Imported through a computed path: the base lives at the repository root,
    // outside this package's tsconfig rootDir.
    const base = (await import(
      /* @vite-ignore */ pathToFileURL(join(root, 'vitest.base.ts')).href
    )) as {
      TEST_TIMEOUT_MS: number;
      baseConfig: { test?: { testTimeout?: number; hookTimeout?: number } };
    };
    expect(base.TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(base.baseConfig.test?.testTimeout).toBe(base.TEST_TIMEOUT_MS);
    expect(base.baseConfig.test?.hookTimeout).toBe(base.TEST_TIMEOUT_MS);
  });
});
