// Le site de docs ne va jamais chercher une police sur le réseau (#688).
//
// Même cause que pour apps/web : `next/font/google` télécharge les polices
// pendant `next build`, et le chargeur plante au hasard quand Google répond
// mal. Les polices sont des fichiers du dépôt (`app/fonts/`), déclarés par
// `fonts.css`. Ce paquet n'a pas @nodal-agents/test-kit : un parcours de
// dossier de quelques lignes suffit.
//
// La garde ne s'arrête pas au site : `docs.yml` publie aussi le portail qualité
// (`apps/qa`) sous `/qa/`, et ce portail chargeait ses polices chez Google. Elle
// couvre donc TOUTE source qui écrit le HTML ou le CSS d'une page que Nodal livre
// ou publie. Les plans de `docs/plans/*.html` n'en font pas partie : aucun
// workflow ni aucun build ne les lit, on les ouvre depuis le dépôt.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const fontsDir = join(docsRoot, 'app', 'fonts');
const qaRoot = join(docsRoot, '..', 'qa');
const FORBIDDEN = /next\/font\/google|@next\/font|fonts\.googleapis\.com|fonts\.gstatic\.com/;

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['node_modules', '.next', 'out', 'tests', '.source', 'dist', 'data'].includes(entry))
        continue;
      sources(full, acc);
    } else if (/\.(tsx?|css|mjs|js|html)$/.test(entry) && !/\.test\.[mc]?[jt]s$/.test(entry)) {
      acc.push(full);
    }
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

  it('no source of the QA portal, published under /qa/ by docs.yml, loads a font from the network', () => {
    expect(existsSync(qaRoot), 'apps/qa is missing: the guard would scan nothing').toBe(true);
    const files = sources(qaRoot);
    // Le portail se rend dans build.mjs : une garde qui ne le lirait pas serait vide.
    expect(files.map((f) => f.slice(qaRoot.length + 1))).toContain('build.mjs');
    const offenders = files.filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')));
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
