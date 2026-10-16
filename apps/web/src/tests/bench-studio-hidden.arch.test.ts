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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STUDIO_CSRF_ENV,
  STUDIO_CSRF_HEADER,
  STUDIO_ENV as BENCH_STUDIO_ENV,
  STUDIO_GATE_ENV,
  studioRefusal,
} from '../lib/bench-studio/guard';
import { CSRF_META, studioPost } from '../app/(bench-studio)/bench-studio/_components/studio-fetch';

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
        'bench-studio/results/page.studio.tsx',
        'bench-studio/api/plan/route.studio.ts',
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
  const CSRF = 'c'.repeat(48);
  const get = (gateHeader: string | null) => ({ gateHeader, method: 'GET', csrfHeader: null });
  it('needs the studio switch AND the gate token of the server, never one of the two', () => {
    expect(studioRefusal({}, get(GATE))).toBe('studio_off');
    expect(studioRefusal({ [BENCH_STUDIO_ENV]: '0', [STUDIO_GATE_ENV]: GATE }, get(GATE))).toBe(
      'studio_off',
    );
    // `next dev` lancé à la main en mode studio, même lié au réseau : pas de jeton.
    expect(studioRefusal({ [BENCH_STUDIO_ENV]: '1' }, get(null))).toBe('studio_no_gate');
    expect(
      studioRefusal({ [BENCH_STUDIO_ENV]: '1', [STUDIO_GATE_ENV]: 'short' }, get('short')),
    ).toBe('studio_no_gate');
    const on = { [BENCH_STUDIO_ENV]: '1', [STUDIO_GATE_ENV]: GATE };
    expect(studioRefusal(on, get(null))).toBe('studio_not_behind_filter');
    expect(studioRefusal(on, get('b'.repeat(48)))).toBe('studio_not_behind_filter');
    expect(studioRefusal(on, get(GATE.slice(1)))).toBe('studio_not_behind_filter');
    expect(studioRefusal(on, get(GATE))).toBeNull();
  });

  it('a request that changes something also needs the CSRF token the page received', () => {
    const on = { [BENCH_STUDIO_ENV]: '1', [STUDIO_GATE_ENV]: GATE, [STUDIO_CSRF_ENV]: CSRF };
    const post = (csrfHeader: string | null, method = 'POST') => ({
      gateHeader: GATE,
      method,
      csrfHeader,
    });
    expect(studioRefusal(on, post(null))).toBe('studio_no_csrf_token');
    expect(studioRefusal(on, post(GATE))).toBe('studio_no_csrf_token');
    expect(studioRefusal(on, post(CSRF.slice(1)))).toBe('studio_no_csrf_token');
    expect(studioRefusal(on, post(null, 'DELETE'))).toBe('studio_no_csrf_token');
    // Sans jeton configuré, aucune écriture ne passe, même avec un en-tête vide.
    expect(studioRefusal({ [BENCH_STUDIO_ENV]: '1', [STUDIO_GATE_ENV]: GATE }, post(''))).toBe(
      'studio_no_csrf_token',
    );
    expect(studioRefusal(on, post(CSRF))).toBeNull();
    expect(studioRefusal(on, post(null, 'GET'))).toBeNull();
  });

  it('every POST of the studio pages goes through studioPost, which sends the token', () => {
    const files = walk(STUDIO_APP).filter(
      (f) =>
        /\.tsx?$/.test(f) && !f.endsWith(`${sep}studio-fetch.ts`) && !/route\.studio\.ts$/.test(f),
    );
    const raw = files.filter((f) =>
      /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(readFileSync(f, 'utf8')),
    );
    expect(raw.map((f) => relative(WEB, f))).toEqual([]);
    const callers = files.filter((f) => readFileSync(f, 'utf8').includes('studioPost('));
    expect(callers.map((f) => f.split(sep).pop()).sort()).toEqual(['RunPanel.tsx']);
    // Le layout rend le jeton dans la page, là où studioPost le lit.
    expect(readFileSync(join(STUDIO_APP, 'bench-studio', 'layout.studio.tsx'), 'utf8')).toContain(
      '<meta name={CSRF_META} content={studioCsrfToken()} />',
    );
  });

  it('every studio route checks the guard before anything else', () => {
    const routes = walk(STUDIO_APP).filter((f) => f.endsWith('route.studio.ts'));
    expect(routes.length).toBeGreaterThanOrEqual(3);
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

describe('no request can start a session from Bench Studio', () => {
  it('its server routes are reads and an estimate, and nothing else', () => {
    const handlers = walk(STUDIO_APP)
      .filter((f) => f.endsWith('route.studio.ts'))
      .flatMap((f) =>
        [
          ...readFileSync(f, 'utf8').matchAll(
            /export async function (GET|POST|PUT|PATCH|DELETE)\b/g,
          ),
        ].map((m) => `${m[1]} ${relative(STUDIO_APP, f).split(sep).join('/')}`),
      )
      .sort();
    expect(handlers).toEqual([
      'GET bench-studio/api/deliverable/route.studio.ts',
      'GET bench-studio/api/fixture/route.studio.ts',
      'POST bench-studio/api/plan/route.studio.ts',
    ]);
  });

  it('no studio file reaches the code that plays a session', () => {
    const files = [...walk(STUDIO_APP), ...walk(STUDIO_LIB)].filter((f) => /\.tsx?$/.test(f));
    const reaching = files.filter((f) =>
      /\b(runBench|runTrial|startRunTask|RunManager|BenchStop)\b|workflows\/(session|trial|mcp)/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(reaching.map((f) => relative(WEB, f))).toEqual([]);
  });

  it('the Launch button is always disabled and says why', () => {
    const panel = readFileSync(join(STUDIO_APP, 'bench-studio', 'run', 'RunPanel.tsx'), 'utf8');
    expect(panel).toContain('<PrimaryButton variant="agent" disabled>');
    expect(panel).not.toMatch(/onClick=\{[^}]*launch/i);
    expect(
      readFileSync(join(STUDIO_APP, 'bench-studio', 'run', 'page.studio.tsx'), 'utf8'),
    ).toContain('launchDisabledReason={LAUNCH_DISABLED_REASON}');
  });
});

describe('studioPost sends the token the page received, and nothing without it', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reads the token rendered by the layout and puts it in the CSRF header', async () => {
    const sent: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      sent.push([url, init]);
      return Promise.resolve(new Response('{}'));
    });
    document.head.innerHTML = `<meta name="${CSRF_META}" content="${'t'.repeat(48)}">`;
    await studioPost('/bench-studio/api/plan', { trials: 1 });
    expect(sent).toEqual([
      [
        '/bench-studio/api/plan',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', [STUDIO_CSRF_HEADER]: 't'.repeat(48) },
          body: '{"trials":1}',
          signal: undefined,
        },
      ],
    ]);
  });

  it('a page without the token sends nothing and says so', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', (...a: unknown[]) => {
      sent.push(a);
      return Promise.resolve(new Response('{}'));
    });
    await expect(studioPost('/bench-studio/api/plan', {})).rejects.toThrow('studio_no_csrf_token');
    expect(sent).toEqual([]);
  });
});
