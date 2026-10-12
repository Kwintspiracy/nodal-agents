// Le site de docs ne va jamais chercher une police sur le réseau (#688).
//
// Même cause que pour apps/web : `next/font/google` télécharge les polices
// pendant `next build`, et le chargeur plante au hasard quand Google répond
// mal. Les polices sont des fichiers du dépôt (`app/fonts/`), déclarés par
// `fonts.css`. Ce paquet n'a pas @nodal-agents/test-kit : un parcours de
// dossier de quelques lignes suffit.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const fontsDir = join(docsRoot, 'app', 'fonts');
const FORBIDDEN = /next\/font\/google|@next\/font|fonts\.googleapis\.com|fonts\.gstatic\.com/;

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['node_modules', '.next', 'out', 'tests', '.source'].includes(entry)) continue;
      sources(full, acc);
    } else if (/\.(tsx?|css|mjs|js|html)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('docs fonts are self-hosted (#688)', () => {
  it('no source of the docs app loads a font from the network', () => {
    const offenders = ['app', 'lib', 'content']
      .flatMap((d) => (existsSync(join(docsRoot, d)) ? sources(join(docsRoot, d)) : []))
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every @font-face points at a committed file, and every family ships its licence', () => {
    const css = readFileSync(join(fontsDir, 'fonts.css'), 'utf8');
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^\.\/[\w.-]+\.woff2$/);
      expect(existsSync(join(fontsDir, url)), `${url} is not committed`).toBe(true);
    }
    const families = new Set(
      [...css.matchAll(/@font-face\s*\{[^}]*?font-family:\s*'([^']+)';[^}]*?\burl\(/g)].map(
        (m) => m[1] ?? '',
      ),
    );
    expect([...families].sort()).toEqual([
      'Archivo',
      'IBM Plex Mono',
      'Instrument Sans',
      'Inter',
      'JetBrains Mono',
      'Public Sans',
    ]);
    const files = readdirSync(fontsDir);
    for (const family of families) {
      expect(files, `licence of ${family}`).toContain(`OFL-${family.replace(/ /g, '')}.txt`);
    }
  });

  it('defines every variable the stylesheets consume, and the layout loads the sheet', () => {
    const css = readFileSync(join(fontsDir, 'fonts.css'), 'utf8');
    const consumers =
      readFileSync(join(docsRoot, 'app', 'global.css'), 'utf8') +
      readFileSync(join(docsRoot, 'app', 'home.css'), 'utf8');
    const used = [
      ...new Set([...consumers.matchAll(/var\((--font-[a-z]+)\)/g)].map((m) => m[1] ?? '')),
    ];
    expect(used.sort()).toEqual([
      '--font-archivo',
      '--font-instrument',
      '--font-inter',
      '--font-jbmono',
      '--font-plexmono',
      '--font-publicsans',
    ]);
    for (const variable of used) expect(css, variable).toContain(`${variable}: '`);
    expect(readFileSync(join(docsRoot, 'app', 'layout.tsx'), 'utf8')).toContain(
      "import './fonts/fonts.css';",
    );
  });
});
