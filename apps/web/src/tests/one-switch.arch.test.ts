// one-switch.arch.test.ts — la conformité par la machine pour l'issue #236.
//
// Pourquoi ce fichier existe : le 19/09/2026 Quentin a vu le toggle du serveur
// MCP avoir l'air désactivé alors qu'il était allumé, et a constaté « plusieurs
// toggles différents un peu partout ». La cause n'était pas une faute d'un
// appelant : c'était que le composant `ui/Switch.tsx` ne possédait que la
// géométrie et laissait chaque appelant peindre sa piste et son bouton. Neuf
// fichiers dessinaient une forme d'interrupteur.
//
// Corriger les neuf ne suffit pas : rien n'empêcherait le dixième. Cette garde
// est ce qui l'empêche, et elle ne demande la vigilance de personne.
//
// La première version ne cherchait que trois littéraux, et Reviewer C a montré
// qu'elle laissait passer trois façons réalistes de redessiner un interrupteur.
// Chacune a désormais sa règle ET son cas de test SUR UN FICHIER FABRIQUÉ :
// une garde dont on n'a jamais vu le rouge ne prouve rien.
//
// Ce qui est refusé, et pourquoi chaque règle est écrite ainsi :
//
//   1. un rôle d'interrupteur ailleurs que dans `ui/Switch.tsx`, QUEL QUE SOIT
//      le guillemet : guillemets doubles, simples, ou une accolade JSX.
//      Chercher le seul littéral à guillemets doubles laissait passer les deux
//      autres.
//   2. `aria-checked` hors du composant. Un interrupteur dessiné à la main
//      porte cet attribut même quand son auteur a oublié le rôle. Les rôles qui
//      le portent légitimement — radio, checkbox et leurs variantes de menu —
//      sont exemptés, sinon `ui/OptionRadio.tsx` rougirait à tort.
//   3. la forme, par deux chemins :
//      a. une même chaîne de classes portant `translate-x` ET `rounded-full` ;
//      b. le motif `peer` : une case à cocher `appearance-none` habillée en
//         interrupteur répartit ces classes sur PLUSIEURS chaînes, donc la
//         règle (a) ne la voit pas. Elle se cherche par FICHIER : `peer` ou
//         `appearance-none`, avec `rounded-full` et un `translate-x`.
//      Le tiroir du Sidebar glisse aussi (`-translate-x-full`) mais n'est pas
//      rond et n'a pas de `peer` : il ne tombe dans aucun des deux, et c'est le
//      but des ET.
//   4. `trackClassName` / `thumbClassName` — la porte par laquelle une couleur
//      d'appelant revenait dans le composant. Celle-là vaut pour TOUS les
//      fichiers, le composant compris.
//
// Mutations vérifiées, chacune appliquée puis annulée, son cas fabriqué devant
// rougir : le rôle réduit au seul littéral à guillemets doubles ; la règle
// `aria-checked` retirée ; le motif `peer` retiré. Vérifié aussi que le ET de
// la règle 3a remplacé par un OU fait rougir le cas du tiroir du Sidebar — elle
// distingue donc une forme d'interrupteur d'une simple translation.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Le seul fichier autorisé à dessiner un interrupteur. */
const LE_COMPOSANT = join('components', 'ui', 'Switch.tsx');

type Fichier = { chemin: string; texte: string };

/** Un rôle d'interrupteur, quel que soit le guillemet et l'accolade JSX. */
const ROLE_INTERRUPTEUR = /role\s*=\s*\{?\s*["'`]switch["'`]/;

/** Les rôles qui portent légitimement `aria-checked` sans être un interrupteur. */
const ROLE_COCHABLE =
  /role\s*=\s*\{?\s*["'`](?:radio|checkbox|menuitemradio|menuitemcheckbox)["'`]/;

/** Les tests parlent DES interrupteurs : ils en citent les classes et le rôle
 *  sans en dessiner. Les inclure ferait rougir la garde sur elle-même. */
function estUnTest(chemin: string): boolean {
  return /(^|[\\/])__tests__[\\/]/.test(chemin) || /\.test\.tsx?$/.test(chemin);
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) {
      if (nom === 'node_modules' || nom === '.next') continue;
      sources(p, acc);
      continue;
    }
    if (extname(p) === '.tsx' || extname(p) === '.ts') acc.push(p);
  }
  return acc;
}

/** Lit un dossier comme la garde lit `apps/web/src` — même marche, même filtre,
 *  pour que les cas fabriqués empruntent exactement le chemin du vrai scan. */
function lire(dir: string): Fichier[] {
  return sources(dir)
    .map((p) => ({ chemin: relative(dir, p), texte: readFileSync(p, 'utf8') }))
    .filter(({ chemin }) => !estUnTest(chemin));
}

/** Chaque chaîne de classes du fichier : littéraux `"…"` / `'…'` et gabarits. */
function chainesDeClasses(texte: string): string[] {
  return [...texte.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((m) => m[2]!);
}

/** Les interrupteurs dessinés hors du composant, chacun avec sa raison. */
function interrupteursDessinesAilleurs(fichiers: Fichier[]): string[] {
  const trouves: string[] = [];
  for (const { chemin, texte } of fichiers) {
    if (texte.includes('trackClassName') || texte.includes('thumbClassName')) {
      trouves.push(`${chemin} — couleur passée par l'appelant`);
    }
    if (chemin === LE_COMPOSANT) continue;

    if (ROLE_INTERRUPTEUR.test(texte)) trouves.push(`${chemin} — rôle d'interrupteur`);
    if (texte.includes('aria-checked') && !ROLE_COCHABLE.test(texte)) {
      trouves.push(`${chemin} — aria-checked sans rôle cochable`);
    }

    const classes = chainesDeClasses(texte);
    if (classes.some((c) => c.includes('translate-x') && c.includes('rounded-full'))) {
      trouves.push(`${chemin} — forme d'interrupteur`);
    }
    const habillee = classes.some(
      (c) => /(^|\s)peer(\s|$)/.test(c) || c.includes('appearance-none'),
    );
    const ronde = classes.some((c) => c.includes('rounded-full'));
    const glisse = classes.some((c) => c.includes('translate-x'));
    if (habillee && ronde && glisse) {
      trouves.push(`${chemin} — case à cocher habillée en interrupteur`);
    }
  }
  return trouves;
}

const FICHIERS = lire(SRC_DIR);

describe('architecture — un seul composant Switch dessine un interrupteur (#236)', () => {
  it('la garde regarde bien tout le dossier source', () => {
    // Sans ce fait, une erreur de chemin rendrait le suivant vert pour la
    // seule raison qu'il ne regarde rien.
    expect(FICHIERS.length).toBeGreaterThan(200);
    expect(FICHIERS.some(({ chemin }) => chemin === LE_COMPOSANT)).toBe(true);
  });

  it('aucun fichier de apps/web/src ne redessine un interrupteur', () => {
    expect(interrupteursDessinesAilleurs(FICHIERS)).toEqual([]);
  });
});

// Ce que la garde ATTRAPE, et ce qu'elle laisse passer. Les cas sont écrits
// dans un dossier temporaire et relus par la même marche que le vrai scan :
// ce qui est prouvé ici, c'est la garde de bout en bout, pas une expression
// régulière sortie de son contexte.
describe('architecture — la garde, sur des fichiers fabriqués', () => {
  // Les littéraux sont assemblés à l'exécution : un scanner qui lirait ce
  // fichier ne doit pas prendre ses exemples pour des déclarations.
  const ROLE = 'role=';
  const ARIA = 'aria-' + 'checked';

  const REFUSES: Array<{ nom: string; source: string; raison: RegExp }> = [
    {
      nom: 'un rôle en guillemets simples',
      source: `export const T = () => <button ${ROLE}'switch' />;`,
      raison: /rôle d'interrupteur/,
    },
    {
      nom: 'un rôle dans une accolade JSX',
      source: `export const T = () => <button ${ROLE}{"switch"} />;`,
      raison: /rôle d'interrupteur/,
    },
    {
      nom: 'aria-checked sans aucun rôle',
      source: `export const T = () => <div ${ARIA}={true} />;`,
      raison: /sans rôle cochable/,
    },
    {
      nom: 'la forme dans une seule chaîne',
      source: `export const T = () => <span className="rounded-full translate-x-4" />;`,
      raison: /forme d'interrupteur/,
    },
    {
      nom: 'une case à cocher habillée, classes éparpillées',
      source: [
        'export const T = () => (',
        '  <label className="relative inline-flex">',
        '    <input type="checkbox" className="peer sr-only" />',
        '    <span className="h-5 w-9 rounded-full bg-ink-4" />',
        '    <span className="absolute translate-x-[3px] peer-checked:translate-x-[19px]" />',
        '  </label>',
        ');',
      ].join('\n'),
      raison: /case à cocher habillée/,
    },
    {
      nom: 'une couleur de piste passée par un appelant',
      source: `export const T = () => <Switch trackClassName="bg-ok" />;`,
      raison: /couleur passée par l'appelant/,
    },
  ];

  const ACCEPTES: Array<{ nom: string; source: string }> = [
    {
      nom: 'le tiroir du Sidebar, qui glisse sans être rond',
      source: `export const T = () => <aside className="fixed border-r transition-transform -translate-x-full" />;`,
    },
    {
      nom: 'OptionRadio, qui porte aria-checked avec un rôle cochable',
      source: `export const T = () => <div ${ROLE}"radio" ${ARIA}={true} className="rounded-[10px]" />;`,
    },
    {
      nom: "le Select, qui a peer sans dessiner d'interrupteur",
      source: `export const T = () => <select className="peer appearance-none rounded-md" />;`,
    },
  ];

  function scanneUnCas(source: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'one-switch-'));
    try {
      writeFileSync(join(dir, 'Cas.tsx'), source, 'utf8');
      return interrupteursDessinesAilleurs(lire(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const { nom, source, raison } of REFUSES) {
    it(`refuse ${nom}`, () => {
      const trouves = scanneUnCas(source);
      expect(trouves).toHaveLength(1);
      expect(trouves[0]).toMatch(raison);
    });
  }

  for (const { nom, source } of ACCEPTES) {
    it(`laisse passer ${nom}`, () => {
      expect(scanneUnCas(source)).toEqual([]);
    });
  }
});
