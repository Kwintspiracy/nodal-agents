// edrow-narrow.spec.ts — EdRow dans une grille ÉTROITE (issue #310).
//
// POURQUOI CE PARCOURS NE VA SUR AUCUNE PAGE. Ce qui est en cause ici est une
// MISE EN PAGE : « la méta se range sous le nom au lieu de se faire recouvrir
// par lui ». Un test jsdom ne peut pas le dire — jsdom n'a pas de moteur de
// rendu, tous ses rectangles valent zéro — et une page du produit ne le dirait
// que si la base de la stack portait une skill au nom assez long, c'est-à-dire
// par accident. Le parcours monte donc le VRAI composant avec la VRAIE feuille
// de style de `apps/web`, dans un conteneur de 400 px, et mesure ce qu'un
// navigateur en fait.
//
// ⚠️ IL EXIGE QUAND MÊME UNE STACK JOIGNABLE, sans s'en servir : le
// `globalSetup` de `playwright.config.ts` interroge `/api/health` avant le
// premier cas, pour toute la suite. En CI la stack est démarrée par le job
// `e2e-smoke` ; en local, lancer ce fichier seul demande la même chose.
//
// Ce qu'on a vu le 20/09, à 1393 px de large, dans le bloc « Skills attached »
// de l'onglet Overview (trois cartes par rangée, donc 294 px par carte) : le
// nom « Command execution » passait à deux lignes, débordait de sa colonne —
// rien ne la coupait — et sa deuxième ligne se dessinait PAR-DESSUS
// « @command-execution » et le bouton « Open ».
//
// ⚠️ ET POURQUOI IL NE PORTE AUCUNE ÉTIQUETTE `@cap:`. Il prouve un
// COMPOSANT du design system, pas une promesse du produit. La première
// version l'avait rangé sous « Give a skill » parce qu'on l'a vu casser dans
// le bloc « Skills attached » ; `apps/qa/lib.test.mjs` a eu raison de le
// refuser : cette capacité attend encore un parcours qui attache une skill
// puis la retire, et peindre sa colonne « écran » en vert avec une mesure de
// mise en page aurait effacé ce plan-là. Une étiquette se met quand le test
// prouve la CAPACITÉ, pas quand il tourne sur le même écran.
//
// Mutation vérifiée : `flex-wrap` retiré de la rangée d'`EdRow` → le premier
// cas rougit (la méta remonte à côté du nom, que le nom recouvre alors).

import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const exiger = createRequire(resolve('package.json'));

/** Le dossier de travail du parcours. Effacé à la fin. */
const ATELIER = resolve('tests/e2e/.tmp-edrow');

/**
 * Le VRAI `EdRow`, compilé ici plutôt qu'importé.
 *
 * ⚠️ POURQUOI ON NE PEUT PAS L'IMPORTER DIRECTEMENT. Playwright compile le JSX
 * de tout ce qu'un test importe avec SON runtime (des objets `__pw_type`,
 * destinés à ses tests de composants), et `renderToStaticMarkup` les refuse :
 * « Objects are not valid as a React child ». On transpile donc le fichier du
 * produit avec `typescript`, en JSX React, dans un module VOISIN — voisin pour
 * que `react/jsx-runtime` se résolve depuis `apps/web`.
 *
 * Ce qui est mesuré reste le fichier du produit, lu sur disque : aucune copie
 * de ses classes n'est écrite ici, et une classe changée dans `EdRow.tsx`
 * change ce parcours.
 */
async function chargerEdRow(): Promise<unknown> {
  const ts = exiger('typescript');
  const source = readFileSync(resolve('src/components/ui/EdRow.tsx'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  mkdirSync(ATELIER, { recursive: true });
  const fichier = join(ATELIER, 'EdRow.mjs');
  writeFileSync(fichier, js, 'utf8');
  const mod = (await import(pathToFileURL(fichier).href)) as { default: unknown };
  return mod.default;
}

/**
 * La feuille de style RÉELLE de `apps/web`, compilée comme le fait le build.
 *
 * Écrire les classes à la main ne prouverait rien : c'est justement la valeur
 * que Tailwind donne à `flex-[1_1_10rem]` et à `flex-wrap` qui est en cause.
 * La compilation prend environ 300 ms, et le résultat sert aux trois cas.
 */
let cssCompilee: string | null = null;
async function feuilleDeStyle(): Promise<string> {
  if (cssCompilee !== null) return cssCompilee;
  const depuisTailwind = createRequire(exiger.resolve('@tailwindcss/postcss'));
  const postcss = depuisTailwind('postcss');
  const tailwind = exiger('@tailwindcss/postcss');
  const entree = resolve('src/app/globals.css');
  const resultat = await postcss([tailwind({ base: resolve('.') })]).process(
    readFileSync(entree, 'utf8'),
    { from: entree },
  );
  cssCompilee = String(resultat.css);
  return cssCompilee;
}

/** La page complète : la feuille réelle, puis le composant rendu. */
async function pageAvec(largeur: number): Promise<string> {
  const EdRow = await chargerEdRow();
  const css = await feuilleDeStyle();
  // Pas de JSX dans ce fichier non plus, pour la raison dite plus haut.
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      { style: { width: largeur } },
      createElement(EdRow as never, {
        // La pastille de 36 px que la vraie rangée porte : elle prend sa place
        // dans le calcul, et la laisser de côté ferait tenir la rangée là où
        // le produit la fait déborder.
        glyph: createElement('span', {
          style: { display: 'block', width: 36, height: 36 },
          'data-testid': 'glyphe',
        }),
        name: 'Command execution',
        description: 'Run shell commands in the agent workspace',
        meta: '@command-execution',
        actions: createElement('span', { 'data-testid': 'action' }, 'Open'),
      }),
    ),
  );
  return (
    `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">` +
    `<style>${css}</style><style>html,body{margin:0;padding:0}</style></head>` +
    `<body class="bg-canvas text-ink">${markup}</body></html>`
  );
}

/**
 * Les trois rectangles qui décident : le nom, la méta, l'action.
 *
 * La méta est reconnue par sa classe de style, celle que le composant lui
 * donne — et non par sa place dans la fratrie, qui est justement ce qui change
 * quand la rangée se replie.
 */
const MESURER = `(() => {
  const boite = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
    };
  };
  const rangee = document.querySelector('[data-testid="ed-row"]');
  // Dire CE QUI MANQUE plutot que lever un TypeError sur null : un cas
  // qui meurt sur « Cannot read properties of null » ne dit rien du composant.
  if (rangee === null) return { absent: 'ed-row' };
  const ligne = rangee.firstElementChild;
  const meta = [...ligne.children].find((c) => c.className.includes('text-mono-11'));
  return {
    nom: boite(ligne.querySelector('.text-medium-14')),
    meta: boite(meta),
    action: boite(document.querySelector('[data-testid="action"]')),
  };
})()`;

type Boite = { left: number; right: number; top: number; bottom: number };
type Mesures = {
  nom?: Boite | null;
  meta?: Boite | null;
  action?: Boite | null;
  /** Ce qui n'a pas été trouvé dans la page, quand rien n'a pu être mesuré. */
  absent?: string;
};

/**
 * Les trois boîtes, ou un échec qui NOMME ce qui manque.
 *
 * Les trois cas passent par ici : un seul endroit sait dire « la rangée n'est
 * pas là » ou « la méta n'est pas là », et aucun ne meurt sur un `null`.
 */
function boites(m: Mesures): { nom: Boite; meta: Boite; action: Boite } {
  expect(m.absent, `rien à mesurer : ${m.absent ?? ''} manque dans la page`).toBeUndefined();
  expect(m.nom, 'le nom est rendu').toBeTruthy();
  expect(m.meta, 'la méta est rendue').toBeTruthy();
  expect(m.action, "l'action est rendue").toBeTruthy();
  return { nom: m.nom as Boite, meta: m.meta as Boite, action: m.action as Boite };
}

test.afterAll(() => {
  rmSync(ATELIER, { recursive: true, force: true });
});

test.describe('EdRow dans une grille étroite', () => {
  // 294 px est la largeur MESURÉE d'une carte du bloc « Skills attached » à
  // 1393 px de large (trois par rangée), celle de la capture de l'issue. C'est
  // là que la rangée débordait.
  test('dans une carte de 294 px, la méta est SOUS le nom', async ({ page }) => {
    await page.setContent(await pageAvec(294));
    const { nom, meta, action } = boites((await page.evaluate(MESURER)) as Mesures);

    // LE FAIT DEMANDÉ PAR L'ISSUE : la méta commence là où le nom a fini, ou
    // plus bas. Avant le correctif elle était à sa droite, et recouverte.
    expect(meta.top, 'la méta commence sous le nom').toBeGreaterThanOrEqual(nom.bottom);
    // Et le nom tient sur une seule ligne de texte : c'est la place rendue par
    // le repli qui le permet. Il en prenait trois avant.
    expect(nom.bottom - nom.top, 'le nom tient sur une ligne').toBeLessThan(24);
    // Rien ne sort de la carte.
    expect(nom.right, 'le nom ne sort pas de la carte').toBeLessThanOrEqual(294);
    expect(meta.right, 'la méta ne sort pas de la carte').toBeLessThanOrEqual(294);
    expect(action.right, "l'action ne sort pas de la carte").toBeLessThanOrEqual(294);
  });

  test('dans 400 px, rien ne se recouvre', async ({ page }) => {
    // La largeur que l'issue nomme. La rangée y tient mieux qu'à 294 — la
    // méta reste à côté du nom — et c'est justement pour cela qu'on la
    // vérifie : le repli ne doit pas être la seule chose qui empêche le
    // recouvrement.
    await page.setContent(await pageAvec(400));
    const { nom, meta } = boites((await page.evaluate(MESURER)) as Mesures);

    // ⚠️ LES DEUX MISES EN PAGE SONT ACCEPTÉES ICI, et c'est voulu : 400 px
    // tombe près du seuil de repli, et la page n'embarque aucune police, donc
    // la largeur du texte dépend des polices du SYSTÈME — Linux en CI,
    // Windows ici. Figer la mise en page à cette largeur rendrait le cas
    // rouge sur une machine et vert sur l'autre. Ce qu'il interdit, lui, vaut
    // partout : le nom ne recouvre rien. Les deux seuils, eux, sont tenus par
    // les cas voisins (294 replie, 900 non).
    const memeLigne = meta.top < nom.bottom && meta.bottom > nom.top;
    if (memeLigne) {
      expect(nom.right, 'le nom s’arrête avant la méta').toBeLessThanOrEqual(meta.left);
    } else {
      expect(meta.top, 'la méta est sous le nom').toBeGreaterThanOrEqual(nom.bottom);
    }
    expect(nom.right, 'le nom ne sort pas du conteneur').toBeLessThanOrEqual(400);
  });

  test('large, tout reste sur UNE ligne', async ({ page }) => {
    // Le repli ne doit pas se déclencher là où la planche dessine une rangée
    // pleine largeur : la méta reste à droite du nom, sur la même ligne. Sans
    // ce cas, « tout mettre sous le nom, toujours » passerait les deux autres.
    await page.setContent(await pageAvec(900));
    const { nom, meta } = boites((await page.evaluate(MESURER)) as Mesures);

    expect(meta.top < nom.bottom && meta.bottom > nom.top, 'la méta est sur la ligne du nom').toBe(
      true,
    );
    expect(meta.left, 'la méta est à droite du nom').toBeGreaterThanOrEqual(nom.right);
  });
});
