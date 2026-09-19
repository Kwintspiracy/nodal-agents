// capture-sidebar.mjs — photographie la barre latérale pour la comparer à la
// planche (#230, 19/09/2026).
//
// POURQUOI. Les planches du propriétaire sont la spécification, et une
// ressemblance affirmée n'est pas une vérification. Il faut une IMAGE du
// rendu ; la stack de développement n'est pas disponible ici, et un test jsdom
// ne dessine pas.
//
// COMMENT. Le markup vient du VRAI rendu des composants
// (`sidebar-markup.capture.test.tsx` l'écrit sur disque), et la feuille de
// style est celle de l'application, compilée par Tailwind sur les mêmes
// sources. Ce qui est photographié est donc le produit, pas une maquette
// réécrite pour l'occasion.
//
// Usage : node scripts/capture-sidebar.mjs <dossier>
//   Le dossier doit déjà contenir talk.html, build.html et run.html.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dossier = resolve(process.argv[2] ?? '');
if (dossier === '') {
  console.error('usage: node scripts/capture-sidebar.mjs <dossier>');
  process.exit(1);
}

/** La feuille de style de l'application, compilée sur les sources réelles. */
async function compilerCss() {
  // `postcss` n'est pas une dépendance DIRECTE de l'application : elle vient
  // avec le plugin de Tailwind. On le résout donc depuis lui, au lieu de
  // l'ajouter au manifeste pour un script de vérification.
  const depuisTailwind = createRequire(require.resolve('@tailwindcss/postcss'));
  const postcss = depuisTailwind('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const source = readFileSync(resolve('src/app/globals.css'), 'utf8');
  const resultat = await postcss([tailwind({ base: resolve('.') })]).process(source, {
    from: resolve('src/app/globals.css'),
  });
  return resultat.css;
}

const css = await compilerCss();
writeFileSync(join(dossier, 'app.css'), css, 'utf8');

const { chromium } = require('@playwright/test');
const navigateur = await chromium.launch();

for (const theme of ['light', 'dark']) {
  for (const nom of ['talk', 'build', 'run']) {
    const markup = readFileSync(join(dossier, `${nom}.html`), 'utf8');
    const page = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>${css}</style>
<style>html,body{margin:0;padding:0;height:720px;overflow:hidden}</style>
</head><body class="bg-canvas text-ink">${markup}</body></html>`;
    writeFileSync(join(dossier, `${nom}-${theme}.html`), page, 'utf8');

    // ⚠️ LA FENÊTRE FAIT 1280 px, PAS 352. La barre ne prend sa forme de
    // bureau qu'au point de rupture `lg` (1024 px) : photographiée dans une
    // fenêtre de 352, elle est le menu MOBILE, garé hors écran — la première
    // capture n'a montré que sa barre de titre. On cadre donc large, et on
    // DÉCOUPE l'élément, qui fait bien ses 352 px.
    const onglet = await navigateur.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    await onglet.goto('file:///' + join(dossier, `${nom}-${theme}.html`).replace(/\\/g, '/'));
    await onglet.locator('#primary-nav').screenshot({ path: join(dossier, `${nom}-${theme}.png`) });
    await onglet.close();
    console.log(`${nom}-${theme}.png`);
  }
}

await navigateur.close();
