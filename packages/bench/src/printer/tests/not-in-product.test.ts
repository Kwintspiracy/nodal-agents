// not-in-product.test.ts — l'imprimante du banc (#794) ne vit qu'avec le banc.
//
// Ce serveur n'imprime rien : il ne doit jamais partir dans le produit. Deux
// preuves sur le code lui-même, en plus du contrôle du pack
// (scripts/lib/bench-studio-absent.mjs, appelé par build-pack.mjs) :
//   1. rien de ce qui peut partir dans le produit, hors de packages/bench, ne le
//      nomme (le produit = CLI, runner, web et leurs dépendances de workspace,
//      voir product-scope.ts : le portail qualité, qui catalogue tous les
//      fichiers de test, n'en fait pas partie) ;
//   2. depuis chaque point d'entrée que le paquet du banc exporte (c'est par eux
//      seuls que l'application web, la seule à l'importer, l'atteint), le
//      graphe d'imports ne touche ni le serveur, ni son point de lancement, ni la
//      fabrique de sa déclaration.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productFiles } from './product-scope';

const BENCH = resolve(__dirname, '..', '..', '..');
const REPO = resolve(BENCH, '..', '..');

// declaration.ts n'y est plus : le juge compare la ligne de la base à ce qu'elle
// rend (`readBenchPrinter`), et la lit donc. Elle ne lance rien (la résolution de
// tsx se fait à l'appel) ; le serveur, son point de lancement et son compteur de
// pages restent hors de tout export.
const SERVER_ONLY = ['server.ts', 'main.ts', 'pages.ts'].map((f) =>
  join(BENCH, 'src', 'printer', f),
);

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(c) && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

/** Tout ce que `entry` atteint par des imports relatifs (statiques ou dynamiques). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const next = resolveImport(file, m[1]!);
      if (next) todo.push(next);
    }
  }
  return seen;
}

describe('the bench printer never reaches the product', () => {
  const pkg = JSON.parse(readFileSync(join(BENCH, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };

  it('the package exports at least the entries the web application imports', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './results', './studio']);
  });

  it.each(Object.entries(pkg.exports))(
    'the export %s does not reach the server, its launcher or its page counter',
    (_name, target) => {
      const reached = reachable(resolve(BENCH, target));
      expect(reached.size).toBeGreaterThanOrEqual(1);
      expect(
        [...reached].filter((f) => SERVER_ONLY.includes(f)).map((f) => relative(BENCH, f)),
      ).toEqual([]);
    },
  );

  const NAMES_PRINTER =
    /bench[\/](src[\/])?printer|@nodal-agents\/bench\/printer|bench_printer_record/;

  const shippable = (): string[] => {
    const tracked = spawnSync('git', ['ls-files', '--', 'apps', 'packages'], {
      cwd: REPO,
      encoding: 'utf8',
    }).stdout.split('\n');
    return productFiles(
      tracked.filter((f) => existsSync(join(REPO, f))),
      (f) => readFileSync(join(REPO, f), 'utf8'),
      'packages/bench/',
    );
  };

  it('nothing outside packages/bench that can ship names the printer', () => {
    const own = shippable().filter((f) => /\.(ts|tsx|mjs|js|json)$/.test(f));
    expect(own.length).toBeGreaterThan(100);
    // The scope is the product, not "everything": the entries and a dependency are in it.
    for (const root of ['apps/web/src/', 'apps/runner/src/', 'apps/cli/src/', 'packages/db/src/']) {
      expect(own.some((f) => f.startsWith(root))).toBe(true);
    }
    const naming = own.filter((f) => NAMES_PRINTER.test(readFileSync(join(REPO, f), 'utf8')));
    expect(naming).toEqual([]);
  });

  it('the quality portal, which catalogues every test file, is outside the product scope', () => {
    const own = shippable();
    expect(own.filter((f) => f.startsWith('apps/qa/'))).toEqual([]);
    expect(own.filter((f) => f.startsWith('apps/docs/'))).toEqual([]);
  });
});

describe('productFiles', () => {
  const manifest = (name: string, deps: Record<string, string> = {}) =>
    JSON.stringify({ name, dependencies: deps });
  const files: Record<string, string> = {
    'apps/cli/package.json': manifest('nodal-agents', { '@nodal-agents/shared': 'workspace:*' }),
    'apps/cli/src/a.ts': '',
    'apps/runner/package.json': manifest('@nodal-agents/runner', {
      '@nodal-agents/tools': 'workspace:*',
    }),
    'apps/runner/src/b.ts': '',
    'apps/web/package.json': manifest('@nodal-agents/web', {
      '@nodal-agents/bench': 'workspace:*',
    }),
    'apps/web/src/c.ts': '',
    'packages/shared/package.json': manifest('@nodal-agents/shared'),
    'packages/shared/src/d.ts': '',
    // reached only through a dependency of a dependency
    'packages/tools/package.json': manifest('@nodal-agents/tools', {
      '@nodal-agents/memory': 'workspace:*',
    }),
    'packages/tools/src/e.ts': '',
    'packages/memory/package.json': manifest('@nodal-agents/memory'),
    'packages/memory/src/f.ts': '',
    'packages/bench/package.json': manifest('@nodal-agents/bench'),
    'packages/bench/src/printer/g.ts': '',
    // nobody in the closure depends on these
    'apps/qa/package.json': manifest('@nodal-agents/qa'),
    'apps/qa/data/snapshot.json': '',
    'packages/orphan/package.json': manifest('@nodal-agents/orphan'),
    'packages/orphan/src/h.ts': '',
  };

  it('keeps the entries and their transitive workspace dependencies, minus the excluded one', () => {
    const got = productFiles(Object.keys(files), (f) => files[f]!, 'packages/bench/').filter(
      (f) => !f.endsWith('package.json'),
    );
    expect(got.sort()).toEqual([
      'apps/cli/src/a.ts',
      'apps/runner/src/b.ts',
      'apps/web/src/c.ts',
      'packages/memory/src/f.ts',
      'packages/shared/src/d.ts',
      'packages/tools/src/e.ts',
    ]);
  });

  it('puts a workspace in scope the day a product workspace depends on it', () => {
    const withDep: Record<string, string> = {
      ...files,
      'packages/shared/package.json': manifest('@nodal-agents/shared', {
        '@nodal-agents/orphan': 'workspace:*',
      }),
    };
    const got = productFiles(Object.keys(withDep), (f) => withDep[f]!, 'packages/bench/');
    expect(got).toContain('packages/orphan/src/h.ts');
  });

  it('fails loud when an entry workspace is not tracked', () => {
    expect(() =>
      productFiles(
        Object.keys(files).filter((f) => !f.startsWith('apps/web/')),
        (f) => files[f]!,
        'packages/bench/',
      ),
    ).toThrow(/@nodal-agents\/web/);
  });
});
