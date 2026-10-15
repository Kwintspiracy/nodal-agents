// suites-code.test.ts — les juges du code, sur les VRAIS projets de fixture.
//
// Le cas vert copie la solution de référence (packages/bench/fixtures/solutions)
// dans le projet posé par `prepare` : il prouve à la fois que la fixture se
// résout et que le juge, qui relance lui-même `node --test`, la voit passer.
// Les cas rouges défont une partie du travail : un test supprimé, un test
// modifié, une suite que l'agent n'a jamais lancée.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../fixtures';
import { revenueByRegion, declaredTests, runNodeTests } from '../suites/code';
import { play } from './harness';

const RAN_TESTS = { name: 'run_command', input: { command: 'npm test' } };
const solve = (project: string) => (root: string) =>
  cpSync(join(FIXTURES_DIR, 'solutions', project), join(root, 'nodal-bench', project), {
    recursive: true,
  });

describe('the code fixtures are real problems', () => {
  it('each fixture suite FAILS as delivered, and passes once solved', async () => {
    for (const p of ['http-somme', 'facture-tva']) {
      const { root } = await play(`code-${p === 'http-somme' ? 'http-server' : 'bugfix'}`, {});
      const dir = join(root, 'nodal-bench', p);
      const before = runNodeTests(dir);
      expect(before.exitCode).not.toBe(0);
      expect(before.failed.length).toBeGreaterThan(0);
      solve(p)(root);
      const after = runNodeTests(dir);
      expect(after.exitCode).toBe(0);
      expect(after.failed).toEqual([]);
    }
  });

  it('reads the declared test names from a test file', () => {
    const src = readFileSync(join(FIXTURES_DIR, 'code', 'http-somme', 'test', 'server.js'), 'utf8');
    expect(declaredTests(src)).toEqual([
      'GET /somme additionne a et b',
      'les décimaux et les négatifs',
      "un paramètre qui n'est pas un nombre est une erreur 400",
      'une autre route répond 404',
    ]);
  });
});

describe('code-http-server judge', () => {
  it('green: solved, suite run by the agent, tests untouched', async () => {
    expect(
      (await play('code-http-server', { tools: [RAN_TESTS] }, solve('http-somme'))).reasons,
    ).toEqual([]);
  });

  it('red: nothing done — the bench reruns the suite and names the failing tests', async () => {
    const r = await play('code-http-server', { tools: [RAN_TESTS] });
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(
      /^rerun by the bench, 4 test\(s\) do not pass: GET \/somme additionne a et b; /,
    );
  });

  it('red: a deleted test file does not make the suite pass', async () => {
    const r = await play('code-http-server', { tools: [RAN_TESTS] }, (root) => {
      solve('http-somme')(root);
      rmSync(join(root, 'nodal-bench', 'http-somme', 'test', 'server.js'));
    });
    expect(r.reasons[0]).toBe('the test file test/server.js was deleted');
    expect(r.reasons[1]).toMatch(/^rerun by the bench, 4 test\(s\) do not pass/);
  });

  it('red: a test rewritten to pass is seen, even though the suite is green', async () => {
    const r = await play('code-http-server', { tools: [RAN_TESTS] }, (root) => {
      solve('http-somme')(root);
      const t = join(root, 'nodal-bench', 'http-somme', 'test', 'server.js');
      writeFileSync(t, readFileSync(t, 'utf8').replace('somme: 5', 'somme: 5 ')); // octets changés, sens identique
    });
    expect(r.reasons).toEqual(['the test file test/server.js was changed']);
  });

  it('red: the agent never ran the suite itself', async () => {
    expect((await play('code-http-server', {}, solve('http-somme'))).reasons).toEqual([
      'the agent never ran the test suite',
    ]);
  });
});

describe('code-bugfix judge', () => {
  it('green: the bug fixed and the suite passing', async () => {
    expect(
      (await play('code-bugfix', { tools: [RAN_TESTS] }, solve('facture-tva'))).reasons,
    ).toEqual([]);
  });
});

describe('code-install-dep judge', () => {
  /** L'installation, faite comme npm la ferait : le paquet dans node_modules et dans package.json. */
  const install = (root: string): void => {
    const dir = join(root, 'nodal-bench', 'slug-titre');
    const pkg = createRequire(import.meta.url).resolve('slugify/package.json');
    cpSync(dirname(pkg), join(dir, 'node_modules', 'slugify'), { recursive: true });
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ ...p, dependencies: { slugify: '^1.6.9' } }),
    );
  };

  it('green: installed, declared, imported, suite passing', async () => {
    const r = await play('code-install-dep', { tools: [RAN_TESTS] }, (root) => {
      install(root);
      solve('slug-titre')(root);
    });
    expect(r.reasons).toEqual([]);
  });

  it('red: the code works but the dependency is not declared in package.json', async () => {
    const r = await play('code-install-dep', { tools: [RAN_TESTS] }, (root) => {
      install(root);
      solve('slug-titre')(root);
      const p = join(root, 'nodal-bench', 'slug-titre', 'package.json');
      writeFileSync(p, readFileSync(join(FIXTURES_DIR, 'code', 'slug-titre', 'package.json')));
    });
    expect(r.reasons).toEqual(['slugify is not in the dependencies of package.json']);
  });
});

describe('code-data judge', () => {
  const RAN = { name: 'run_command', input: { command: 'python calc.py' } };
  const csv = (): string => readFileSync(join(FIXTURES_DIR, 'data', 'ventes-regions.csv'), 'utf8');
  const writeJson = (value: unknown) => (root: string) => {
    mkdirSync(join(root, 'nodal-bench'), { recursive: true });
    writeFileSync(join(root, 'nodal-bench', 'ca-par-region.json'), JSON.stringify(value));
  };

  it('the revenue is recomputed to the cent, for the five regions', () => {
    const want = revenueByRegion(csv());
    expect(Object.keys(want).sort()).toEqual(['Centre', 'Est', 'Nord', 'Ouest', 'Sud']);
    for (const v of Object.values(want)) expect(Math.round(v * 100)).toBe(v * 100);
  });

  it('green: the right numbers, written by a script', async () => {
    expect(
      (await play('code-data', { tools: [RAN] }, writeJson(revenueByRegion(csv())))).reasons,
    ).toEqual([]);
  });

  it('red: a wrong region total and an extra key are named; no script is named too', async () => {
    const want = revenueByRegion(csv());
    const r = await play(
      'code-data',
      {},
      writeJson({ ...want, Nord: want['Nord']! + 1, Total: 1 }),
    );
    expect(r.reasons).toEqual([
      'no Python or Node script ran',
      `Nord is ${want['Nord']! + 1}, expected ${want['Nord']}`,
      'unexpected keys: Total',
    ]);
  });
});
