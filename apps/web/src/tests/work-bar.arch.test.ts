// work-bar.arch.test.ts — la conformité par la machine pour l'issue #242.
//
// Deux décisions du propriétaire le 19/09/2026, et la seconde a défait la
// première.
//
// D'abord, page après page : « trop de pages n'utilisent pas cette barre, ce
// qui veut dire que ce n'est pas un système. Je suis fatigué de donner ce
// retour page après page. » Neuf pages de détail dessinaient chacune son
// propre lien de retour, ou aucun, et les actions de la page tombaient sur la
// ligne du retour.
//
// Puis, le soir même : « Retire les boutons retour PARTOUT. On le remettra
// après testing si je ressens le besoin. À l'heure actuelle ça casse
// complètement la navigation. »
//
// La garde s'est donc INVERSÉE. Elle ne compte plus les pages qui manquent le
// retour : elle refuse qu'il en reste un seul. On se déplace par la barre
// latérale, qui reste visible et dit toujours où l'on est. Le jour où le
// retour revient, c'est ce fichier qu'il faudra rouvrir — et c'est exactement
// pour ça qu'il est écrit.
//
// Ce qu'elle refuse :
//   1. le composant `BackButton`, ses appels, et le module `lib/back-links.ts`
//      qui calculait où « Back to … » menait ;
//   2. `router.back()` / `history.back()` — la même chose sans le composant ;
//   3. un GLYPHE de retour (`←`, `‹`) dans un fichier, sauf les deux contrôles
//      nommés plus bas qui n'en sont pas ;
//   4. une prop `back={…}` passée à un composant.
//
// Ce qu'elle continue d'exiger, parce que cette règle-là tient toute seule :
//   5. une page de détail ne met dans le `toolbar` de son `PageShell` que la
//      `WorkBar` — jamais ses actions, qui vont dans une `ActionRow`.
//
// Elle suit les imports ÉCRITS ; un écran atteint par un `import()` dynamique
// passerait sous son nez. Un sixième fait surveille cette hypothèse, borné au
// périmètre qu'elle parcourt : ailleurs, le chargement dynamique est un usage
// légitime et cette garde n'a pas à en juger.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = join(SRC_DIR, 'app', '(dashboard)');

/**
 * Les « ← » qui ne sont PAS des retours de navigation, et que Quentin a dit de
 * laisser. Chacun est nommé avec ce qu'il fait réellement — une liste de noms
 * sans raison serait une porte dérobée.
 *
 *  · l'assistant d'installation recule d'une ÉTAPE dans son propre formulaire
 *    (`setStep(0)`), il ne va sur aucune page.
 *
 * Elle en comptait un second, `code/CodeProcessesTable.tsx`, qui défaisait une
 * sélection dans la page. Ce fichier a disparu avec #226 (« /code goes to
 * Workspaces »), et c'est le fait « les exceptions sont vérifiables » qui l'a
 * dit, au lieu de laisser une entrée périmée exempter un fichier absent.
 */
const PAS_DES_RETOURS = new Map([
  [join('app', 'onboarding', 'OnboardingFlow.tsx'), 'une étape d’assistant, pas une page'],
]);

/** Les glyphes par lesquels un retour se dessine. */
const GLYPHES = ['←', '‹'];

/**
 * Des pages qui ne sont pas des routes dynamiques mais qui SONT des détails.
 * Une page de création est le détail d'une chose qui n'existe pas encore, et un
 * réglage qui s'ouvre en pleine page est le détail d'un réglage.
 */
const DETAILS_SANS_SEGMENT_DYNAMIQUE = [
  join('skills', 'new', 'page.tsx'),
  join('settings', 'root-context', 'page.tsx'),
];

function estUnTest(chemin: string): boolean {
  return /(^|[\\/])(__tests__|tests)[\\/]/.test(chemin) || /\.test\.tsx?$/.test(chemin);
}

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) {
      if (nom === 'node_modules' || nom === '.next') continue;
      fichiers(p, acc);
      continue;
    }
    if (extname(p) === '.tsx' || extname(p) === '.ts') acc.push(p);
  }
  return acc;
}

const TOUS = fichiers(SRC_DIR)
  .map((p) => ({ abs: p, chemin: relative(SRC_DIR, p), texte: readFileSync(p, 'utf8') }))
  .filter(({ chemin }) => !estUnTest(chemin));

const PAR_CHEMIN = new Map(TOUS.map((f) => [f.chemin, f]));

/**
 * Les lignes qui DESSINENT, c'est-à-dire tout sauf les lignes de commentaire.
 *
 * Sans ce tri, la garde rougissait sur cinq fichiers qui se contentent de
 * PARLER du retour retiré — les commentaires qui disent « le ‹ Back to agents »
 * est parti », le schéma ASCII de `PageShell`, l'exemple de la doc de
 * `TextButton`. Une garde qui interdit de nommer ce qu'elle a supprimé force à
 * effacer la mémoire du pourquoi, ce qui est l'inverse du but.
 *
 * Le tri est volontairement grossier — une ligne dont le début est `//`, `*`
 * ou `/*` — et il ne peut donc pas CACHER un glyphe dessiné : du JSX ne
 * commence jamais par ces trois-là. Un commentaire en fin de ligne de code
 * serait signalé, et c'est le bon sens du doute.
 */
function lignesDeCode(texte: string): string {
  return texte
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Les modules locaux qu'un fichier importe : `./x`, `../x`, `@/x`. Rien d'autre. */
function importsLocaux(texte: string): string[] {
  const specs = [...texte.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
  return specs.filter((s) => s.startsWith('.') || s.startsWith('@/'));
}

/** Le fichier que ce spécificateur désigne, s'il en désigne un des nôtres. */
function resoudre(depuis: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(SRC_DIR, spec.slice(2))
    : resolve(dirname(depuis), spec);
  for (const essai of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx')]) {
    if (existsSync(essai) && statSync(essai).isFile()) return relative(SRC_DIR, essai);
  }
  return null;
}

/** La page ET tout ce qu'elle rend, de proche en proche. */
function fermeture(cheminPage: string): string[] {
  const vus = new Set<string>();
  const pile = [cheminPage];
  while (pile.length > 0) {
    const courant = pile.pop()!;
    if (vus.has(courant)) continue;
    vus.add(courant);
    const f = PAR_CHEMIN.get(courant);
    if (f === undefined) continue;
    for (const spec of importsLocaux(f.texte)) {
      const cible = resoudre(f.abs, spec);
      if (cible !== null && !vus.has(cible)) pile.push(cible);
    }
  }
  return [...vus];
}

const PAGES = fichiers(DASHBOARD)
  .filter((p) => p.endsWith(`${sep}page.tsx`))
  .map((p) => ({ chemin: relative(SRC_DIR, p), texte: readFileSync(p, 'utf8') }));

const DETAILS = PAGES.filter(({ chemin }) => {
  const route = relative(join('app', '(dashboard)'), chemin);
  if (DETAILS_SANS_SEGMENT_DYNAMIQUE.includes(route)) return true;
  return route.includes('[');
});

/**
 * Le PÉRIMÈTRE de la garde pour la règle du `toolbar` : les pages de détail et
 * tout ce qu'elles rendent. Le retrait des retours, lui, vaut partout.
 */
const PERIMETRE = new Set(DETAILS.flatMap(({ chemin }) => fermeture(chemin)));

describe('architecture — plus aucun lien de retour dans le produit (#242)', () => {
  it('la garde regarde bien tout le dossier source', () => {
    // Sans ce fait, une erreur de chemin rendrait les suivants verts pour la
    // seule raison qu'ils ne regardent rien.
    expect(TOUS.length).toBeGreaterThan(200);
    expect(PAGES.length).toBeGreaterThan(20);
    expect(DETAILS.length).toBeGreaterThanOrEqual(8);
    // Et la fermeture suit bien les imports : la page d'un agent ne cite pas
    // son compositeur par hasard, elle le rend.
    const page = join('app', '(dashboard)', 'agents', '[id]', 'edit', 'page.tsx');
    expect(fermeture(page)).toContain(
      join('app', '(dashboard)', 'agents', '[id]', 'edit', 'AgentComposer.tsx'),
    );
  });

  it('le composant BackButton et le calcul des retours n’existent plus', () => {
    expect(existsSync(join(SRC_DIR, 'components', 'ui', 'BackButton.tsx'))).toBe(false);
    expect(existsSync(join(SRC_DIR, 'lib', 'back-links.ts'))).toBe(false);
    const coupables = TOUS.filter(
      ({ texte }) =>
        texte.includes('BackButton') ||
        texte.includes('back-links') ||
        texte.includes('threadBackLink') ||
        texte.includes('runBackLink'),
    ).map(({ chemin }) => chemin);
    expect(coupables).toEqual([]);
  });

  it('personne ne dépile l’historique du navigateur', () => {
    const coupables = TOUS.filter(
      ({ texte }) => texte.includes('router.back()') || texte.includes('history.back()'),
    ).map(({ chemin }) => chemin);
    expect(coupables).toEqual([]);
  });

  it('aucun glyphe de retour DESSINÉ, sauf les contrôles qui n’en sont pas', () => {
    const coupables = TOUS.filter(({ chemin, texte }) => {
      if (PAS_DES_RETOURS.has(chemin)) return false;
      const code = lignesDeCode(texte);
      return GLYPHES.some((g) => code.includes(g));
    }).map(({ chemin }) => chemin);
    expect(coupables).toEqual([]);
  });

  it('les exceptions sont vérifiables, pas des noms sur une liste', () => {
    // Chacune doit EXISTER et faire ce que la liste dit qu'elle fait. Une
    // exception qui se met à naviguer retombe sous la règle précédente ; une
    // dont le fichier a disparu est signalée au lieu de dormir.
    for (const [chemin] of PAS_DES_RETOURS) expect(PAR_CHEMIN.has(chemin)).toBe(true);
    const onboarding = PAR_CHEMIN.get(join('app', 'onboarding', 'OnboardingFlow.tsx'));
    expect(onboarding?.texte).toContain('setStep(0)');
  });

  it('plus personne ne passe une destination de retour à un composant', () => {
    const coupables = TOUS.filter(({ texte }) => /\bback=\{/.test(texte)).map(
      ({ chemin }) => chemin,
    );
    expect(coupables).toEqual([]);
  });

  it('le toolbar d’une page de détail COMMENCE par la barre, jamais par une action', () => {
    // Cette règle-là n'a pas bougé de sens : les actions de la page vivent sur
    // leur propre rangée, SOUS la barre, jamais sur sa ligne.
    //
    // Deux formes sont justes, et la seconde est née avec le panneau ancré de
    // #226 : la barre seule, ou un fragment `<>` qui enchaîne la barre PUIS la
    // rangée d'actions. Sur un écran pleine hauteur, les deux rangées vivent
    // dans le `toolbar` parce que le corps défile sous elles. Ce qui est refusé
    // est la même chose dans les deux cas : que le toolbar commence par autre
    // chose que la barre.
    const coupables: string[] = [];
    for (const chemin of PERIMETRE) {
      const f = PAR_CHEMIN.get(chemin);
      if (f === undefined) continue;
      for (const m of f.texte.matchAll(/toolbar=\{\s*/g)) {
        // On saute un éventuel fragment ouvrant, et lui seul.
        const suite = f.texte.slice(m.index + m[0].length).replace(/^<>\s*/, '');
        if (!suite.startsWith('<WorkBar') && !suite.startsWith('<ThreadWorkBar')) {
          coupables.push(chemin);
          break;
        }
      }
    }
    expect(coupables).toEqual([]);
  });

  it('dans SON périmètre, aucun écran ne se charge dynamiquement', () => {
    const dynamiques = [...PERIMETRE]
      .map((c) => PAR_CHEMIN.get(c))
      .filter(
        (f) =>
          f !== undefined &&
          (f.texte.includes('next/dynamic') || f.texte.includes('await import(')),
      )
      .map((f) => f!.chemin);
    expect(dynamiques).toEqual([]);
  });
});
