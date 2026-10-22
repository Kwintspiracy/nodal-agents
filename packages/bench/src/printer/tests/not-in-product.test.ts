// not-in-product.test.ts — l'imprimante du banc (#794) ne vit qu'avec le banc.
//
// Ce serveur n'imprime rien : il ne doit jamais partir dans le produit. Deux
// preuves sur le code lui-même, en plus du contrôle du pack
// (scripts/lib/bench-studio-absent.mjs, appelé par build-pack.mjs) :
//   1. rien hors de packages/bench ne le nomme ;
//   2. depuis chaque point d'entrée que le paquet du banc exporte (c'est par eux
//      seuls que l'application web, la seule à l'importer, l'atteint), le
//      graphe d'imports ne touche ni le serveur, ni son point de lancement, ni la
//      fabrique de sa déclaration.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('nothing outside packages/bench names the printer', () => {
    const tracked = spawnSync('git', ['ls-files', '--', 'apps', 'packages'], {
      cwd: REPO,
      encoding: 'utf8',
    }).stdout.split('\n');
    const own = tracked.filter(
      (f) =>
        /\.(ts|tsx|mjs|js|json)$/.test(f) &&
        !f.startsWith('packages/bench/') &&
        existsSync(join(REPO, f)),
    );
    expect(own.length).toBeGreaterThan(100);
    const naming = own.filter((f) =>
      /bench[\/](src[\/])?printer|@nodal-agents\/bench\/printer|bench_printer_record/.test(
        readFileSync(join(REPO, f), 'utf8'),
      ),
    );
    expect(naming).toEqual([]);
  });
});
