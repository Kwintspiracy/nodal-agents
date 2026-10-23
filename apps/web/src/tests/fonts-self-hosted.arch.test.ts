// fonts-self-hosted.arch.test.ts — le build ne va jamais chercher une police sur le réseau (#688).
//
// Pourquoi ce fichier existe : `next/font/google` télécharge les polices
// pendant `next build` ET au démarrage de `next dev`. Quand Google répond mal,
// le chargeur plante avec un message différent à chaque fois (« Cannot read
// properties of null (reading '1') », « queries have exactly one entry »,
// HTTP 500 sur une page…) et la CI rougit au hasard : e2e-smoke, build,
// pack-smoke, quatre fois entre le 08 et le 12/10/2026. Les polices sont donc
// des fichiers du dépôt (`src/fonts/`), déclarés par `fonts.css`.
//
// Deux gardes :
//   1. rien dans les sources de l'app ne réintroduit `next/font/google` ni une
//      URL de CDN de polices — la forme qui a cassé, et toute sa famille ;
//   2. chaque `url()` de `fonts.css` est locale ET désigne un fichier qui
//      existe, et chaque famille embarquée a sa licence à côté.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForPattern, assertNoViolations } from '@nodal-agents/test-kit';

const appRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const fontsDir = join(appRoot, 'src', 'fonts');

describe('web fonts are self-hosted (#688)', () => {
  it('no source of the app loads a font from the network', () => {
    assertNoViolations(
      'police chargée depuis le réseau',
      scanForPattern(
        {
          srcDir: appRoot,
          // Le dossier des tests est exclu : celui-ci nomme le motif interdit.
          // Un build ou un rapport (`.next`, `test-results`…) n'est jamais lu :
          // le scanner ne lit que ce que git tient pour source.
          skipDirs: ['tests', '__tests__'],
          extensions: ['.ts', '.tsx', '.css', '.mjs', '.js', '.html'],
        },
        {
          pattern: /next\/font\/google|@next\/font|fonts\.googleapis\.com|fonts\.gstatic\.com/,
          rule: 'font-from-network',
        },
      ),
    );
  });

  it('every @font-face of fonts.css points at a committed file, and every family ships its licence', () => {
    const css = readFileSync(join(fontsDir, 'fonts.css'), 'utf8');
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, 'font url must be relative to fonts.css').toMatch(/^\.\/[\w.-]+\.woff2$/);
      expect(existsSync(join(fontsDir, url)), `${url} is not committed`).toBe(true);
    }
    // Chaque famille déclarée a un fichier de licence OFL-<Famille>.txt.
    const families = new Set(
      [...css.matchAll(/@font-face\s*\{[^}]*?font-family:\s*'([^']+)';[^}]*?\burl\(/g)].map(
        (m) => m[1] ?? '',
      ),
    );
    expect([...families].sort()).toEqual(['Inter', 'JetBrains Mono']);
    const files = readdirSync(fontsDir);
    for (const family of families) {
      expect(files, `licence of ${family}`).toContain(`OFL-${family.replace(/ /g, '')}.txt`);
    }
  });

  it('keeps the CSS variables the app consumes, falling back on a size-adjusted face', () => {
    const css = readFileSync(join(fontsDir, 'fonts.css'), 'utf8');
    expect(css).toContain("--font-inter: 'Inter', 'Inter Fallback';");
    expect(css).toContain("--font-jetbrains: 'JetBrains Mono', 'JetBrains Mono Fallback';");
    // globals.css consomme ces deux variables : si l'une disparaît, la police
    // retombe en silence sur la liste système (invariant #4).
    const globals = readFileSync(join(appRoot, 'src', 'app', 'globals.css'), 'utf8');
    expect(globals).toContain('var(--font-inter,');
    expect(globals).toContain('var(--font-jetbrains,');
    // Le layout charge la feuille ; sans cet import, rien n'est déclaré.
    const layout = readFileSync(join(appRoot, 'src', 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain("import '../fonts/fonts.css';");
  });
});
