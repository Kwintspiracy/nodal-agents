// bench-studio-hidden.arch.test.ts — Bench Studio n'existe que dans `pnpm bench:studio`.
//
// Bench Studio est l'outil LOCAL du propriétaire pour le banc d'essai, et il
// lance des essais. Ce fichier prouve, sur l'arbre des sources, qu'il
// n'apparaît nulle part ailleurs :
//   - chaque fichier de route du studio porte l'extension `.studio` (sinon il
//     serait une route partout) et aucun code hors du studio ne l'importe ;
//   - ses routes refusent toute requête sans le mode studio ET le jeton de son
//     serveur (lib/bench-studio/guard.ts).
// Le next.config (routes seulement en mode studio, dev seulement, son propre
// dossier) est prouvé par scripts/tests/bench-studio.test.mjs, et la CI vérifie
// la sortie réelle (scripts/check-no-bench-studio.mjs).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STUDIO_ENV as BENCH_STUDIO_ENV,
  STUDIO_GATE_ENV,
  studioRefusal,
} from '../lib/bench-studio/guard';

const WEB = resolve(__dirname, '..', '..');
const SRC = join(WEB, 'src');
const STUDIO_APP = join(SRC, 'app', '(bench-studio)');
const STUDIO_LIB = join(SRC, 'lib', 'bench-studio');
const ROUTE_FILES =
  /^(page|layout|route|loading|error|not-found|template|default|global-error|forbidden|unauthorized)\.(tsx?|jsx?)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('Bench Studio stays inside its own folder', () => {
  it('every route file of the studio carries the .studio extension: none is a route in an ordinary build', () => {
    const files = walk(STUDIO_APP).map((f) => relative(STUDIO_APP, f).split(sep).join('/'));
    const routes = files.filter((f) => /(^|\/)(page|layout|route)\.studio\.tsx?$/.test(f));
    // Les quatre écrans et leurs routes existent : la garde ne passe pas sur un dossier vide.
    expect(routes).toEqual(
      expect.arrayContaining([
        'bench-studio/layout.studio.tsx',
        'bench-studio/page.studio.tsx',
        'bench-studio/run/page.studio.tsx',
        'bench-studio/live/[id]/page.studio.tsx',
        'bench-studio/results/page.studio.tsx',
        'bench-studio/api/launch/route.studio.ts',
      ]),
    );
    const plain = files.filter((f) => ROUTE_FILES.test(f.split('/').pop()!));
    expect(plain).toEqual([]);
  });

  it('no code outside the studio imports it', () => {
    const outside = walk(SRC).filter(
      (f) =>
        /\.(tsx?|jsx?|mjs)$/.test(f) &&
        !f.startsWith(STUDIO_APP + sep) &&
        !f.startsWith(STUDIO_LIB + sep) &&
        f !== __filename,
    );
    const importers = outside.filter((f) =>
      /from\s+['"](@nodal-agents\/bench(\/[^'"]*)?|@\/lib\/bench-studio[^'"]*|[^'"]*\(bench-studio\)[^'"]*)['"]/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(importers.map((f) => relative(WEB, f))).toEqual([]);
  });
});

describe('studio routes refuse what did not come through the studio server', () => {
  const GATE = 'a'.repeat(48);
  it('needs the studio switch AND the gate token of the server, never one of the two', () => {
    expect(studioRefusal({}, GATE)).toBe('studio_off');
    expect(studioRefusal({ [BENCH_STUDIO_ENV]: '0', [STUDIO_GATE_ENV]: GATE }, GATE)).toBe(
      'studio_off',
    );
    // `next dev` lancé à la main en mode studio, même lié au réseau : pas de jeton.
    expect(studioRefusal({ [BENCH_STUDIO_ENV]: '1' }, null)).toBe('studio_no_gate');
    expect(studioRefusal({ [BENCH_STUDIO_ENV]: '1', [STUDIO_GATE_ENV]: 'short' }, 'short')).toBe(
      'studio_no_gate',
    );
    const on = { [BENCH_STUDIO_ENV]: '1', [STUDIO_GATE_ENV]: GATE };
    expect(studioRefusal(on, null)).toBe('studio_not_behind_filter');
    expect(studioRefusal(on, 'b'.repeat(48))).toBe('studio_not_behind_filter');
    expect(studioRefusal(on, GATE.slice(1))).toBe('studio_not_behind_filter');
    expect(studioRefusal(on, GATE)).toBeNull();
  });

  it('every studio route checks the guard before anything else', () => {
    const routes = walk(STUDIO_APP).filter((f) => f.endsWith('route.studio.ts'));
    expect(routes.length).toBeGreaterThanOrEqual(7);
    for (const f of routes) {
      const src = readFileSync(f, 'utf8');
      for (const handler of src.matchAll(
        /export async function (GET|POST)\([^)]*\)[^{]*\{\s*([^\n]+)/g,
      )) {
        expect(`${relative(WEB, f)} ${handler[1]}: ${handler[2]!.trim()}`).toMatch(
          /: const refused = studioRouteRefusal\(req\);$/,
        );
      }
    }
    const pages = walk(STUDIO_APP).filter((f) => /(page|layout)\.studio\.tsx$/.test(f));
    for (const f of pages)
      expect(readFileSync(f, 'utf8'), relative(WEB, f)).toContain('await assertStudioPage();');
  });
});
