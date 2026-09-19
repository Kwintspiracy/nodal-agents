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
// ─── CE QUE CETTE GARDE NE VOIT PAS ────────────────────────────────────────
//
// Elle lit du texte, pas un arbre syntaxique, et elle ne prétend pas être
// totale. Trois choses lui échappent par construction, et il vaut mieux les
// écrire que laisser croire à une barrière étanche :
//
//   - un interrupteur SANS rôle, SANS `aria-checked` et dont le pouce n'est
//     positionné par aucune classe qu'elle connaisse. Un tel contrôle n'est de
//     toute façon pas accessible — ni lecteur d'écran, ni clavier — et c'est le
//     lint a11y qui le dira, pas cette garde ;
//   - une classe assemblée à l'exécution (`` `rounded-${forme}` ``) : la garde
//     lit des chaînes littérales ;
//   - une balise JSX dont l'attribut contient un `<` ou un `>` autre qu'une
//     flèche (les flèches sont neutralisées avant le découpage). La balise est
//     alors coupée, et un `aria-checked` orphelin est signalé PLUTÔT
//     qu'ignoré — un rouge se voit, un vert de trop ne se voit pas.
//
// ─── CE QU'ELLE REFUSE ─────────────────────────────────────────────────────
//
//   1. un rôle d'interrupteur ailleurs que dans `ui/Switch.tsx`, QUEL QUE SOIT
//      le guillemet : doubles, simples, ou une accolade JSX. Chercher le seul
//      littéral à guillemets doubles laissait passer les deux autres.
//   2. `aria-checked` hors du composant, SUR LA BALISE QUI LE PORTE. Un
//      interrupteur dessiné à la main porte cet attribut même quand son auteur
//      a oublié le rôle. Les rôles qui le portent légitimement — radio,
//      checkbox et leurs variantes de menu — exemptent LEUR balise et elle
//      seule : à la granularité du fichier, un `role="radio"` posé n'importe
//      où couvrait tous les `aria-checked` du fichier.
//   3. la forme, par trois chemins, du plus sûr au plus large, et un seul
//      verdict par fichier :
//      a. une même chaîne portant `rounded-full` ET `translate-x` ;
//      b. LE VOYAGE : le fichier a une chaîne `rounded-full` et DEUX positions
//         horizontales distinctes (`translate-x-*`, `left-[…]`, `right-[…]`,
//         `ml-[…]`, `mr-[…]`). Deux positions pour une chose ronde, ce sont
//         les deux bouts d'une course. Ne regarder que `translate-x` laissait
//         passer le pouce posé en `left-[19px]`, et ne regarder qu'une seule
//         chaîne laissait passer le ternaire, qui sépare la position de
//         `rounded-full` ;
//      c. le motif `peer` : une case à cocher `appearance-none` habillée
//         n'écrit parfois QUE le bout allumé (`peer-checked:translate-x-…`),
//         donc une seule position lui suffit pour être suspecte.
//      Deux leurres disent pourquoi c'est écrit ainsi : le tiroir du Sidebar
//      voyage entre deux positions mais n'est pas rond, et la pastille de
//      `IconButton` est ronde mais posée à `right-[7px]` pour toujours. La
//      première version de (b), qui acceptait UNE position, la signalait.
//   4. `trackClassName` / `thumbClassName` — la porte par laquelle une couleur
//      d'appelant revenait dans le composant. Celle-là vaut pour TOUS les
//      fichiers, le composant compris.
//
// Chaque règle a son cas SUR UN FICHIER FABRIQUÉ, et chaque leurre le sien :
// une garde dont on n'a jamais vu le rouge ne prouve rien, et une garde dont
// on n'a jamais vu le vert se fait désactiver au premier faux positif.
//
// Mutations vérifiées, chacune appliquée puis annulée, son cas devant rougir :
// le rôle réduit au littéral à guillemets doubles ; la règle `aria-checked`
// retirée ; son exemption ramenée à la granularité fichier ; la règle du
// voyage retirée ; le motif `peer` retiré ; le voyage abaissé à UNE position
// (qui fait rougir le leurre de la pastille).

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

const ARIA_COCHE = 'aria-' + 'checked';

/** Les tests parlent DES interrupteurs : ils en citent les classes et le rôle
 *  sans en dessiner. Les inclure ferait rougir la garde sur elle-même. */
function estUnTest(chemin: string): boolean {
  return /(^|[\\/])__tests__[\\/]/.test(chemin) || /\.test\.[jt]sx?$/.test(chemin);
}

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function sources(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) {
      if (nom === 'node_modules' || nom === '.next') continue;
      sources(p, acc);
      continue;
    }
    if (EXTENSIONS.has(extname(p))) acc.push(p);
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

/** Les balises JSX ouvrantes, attributs compris, sur plusieurs lignes.
 *  Les flèches `=>` sont neutralisées d'abord : leur `>` fermerait la balise au
 *  milieu d'une prop et séparerait un `aria-checked` de son rôle. */
function balisesOuvrantes(texte: string): string[] {
  return [...texte.replace(/=>/g, '=·').matchAll(/<[A-Za-z][^<>]*>/g)].map((m) => m[0]);
}

/** Une position horizontale : le pouce glisse (`translate-x`), on le pose
 *  (`left-[…]` / `right-[…]`) ou on le pousse (`ml-[…]` / `mr-[…]`). Les
 *  marges ne comptent qu'en valeur arbitraire : `ml-2` est partout et ne dit
 *  rien. Le préfixe de variante est accepté (`peer-checked:left-[19px]`). */
const POSITION_X = /(^|[\s:])(-?translate-x-[\w.[\]%/-]+|-?(?:left|right|ml|mr)-\[[^\]\s]+\])/g;

/** Les positions horizontales DISTINCTES d'un fichier. Deux, c'est un voyage :
 *  les deux bouts d'une course. Une seule, c'est un élément posé une fois pour
 *  toutes — une pastille de notification, par exemple. */
function positionsDistinctes(classes: string[]): Set<string> {
  const vues = new Set<string>();
  for (const c of classes) for (const m of c.matchAll(POSITION_X)) vues.add(m[2]!);
  return vues;
}

/** La forme d'un interrupteur dans les classes d'un fichier, ou `null`.
 *  Trois chemins, du plus sûr au plus large, et un seul verdict : un fichier
 *  n'est pas coupable deux fois du même dessin. */
function formeDInterrupteur(classes: string[]): string | null {
  if (classes.some((c) => c.includes('rounded-full') && c.includes('translate-x'))) {
    return "forme d'interrupteur";
  }
  if (!classes.some((c) => c.includes('rounded-full'))) return null;

  const positions = positionsDistinctes(classes);
  // Deux positions pour une chose ronde, c'est une course entre deux bouts.
  // Une seule, c'est un élément posé une fois — la pastille de `IconButton`
  // est à `right-[7px]` et n'en bouge jamais.
  if (positions.size >= 2) return 'pouce rond qui voyage entre deux positions';

  // Le motif `peer` cache la seconde position dans un état CSS : une case à
  // cocher `appearance-none` habillée n'écrit parfois que le bout allumé.
  const habillee = classes.some((c) => /(^|\s)peer(\s|$)/.test(c) || c.includes('appearance-none'));
  if (habillee && positions.size >= 1) return 'case à cocher habillée en interrupteur';

  return null;
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

    if (texte.includes(ARIA_COCHE)) {
      const porteuses = balisesOuvrantes(texte).filter((b) => b.includes(ARIA_COCHE));
      // Aucune balise lisible ne le porte : la garde n'a pas su découper, elle
      // le dit au lieu de se taire.
      const illisible = porteuses.length === 0;
      if (illisible || porteuses.some((b) => !ROLE_COCHABLE.test(b))) {
        trouves.push(`${chemin} — aria-checked sans rôle cochable sur la même balise`);
      }
    }

    const raison = formeDInterrupteur(chainesDeClasses(texte));
    if (raison) trouves.push(`${chemin} — ${raison}`);
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
  const ARIA = ARIA_COCHE;

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
      nom: 'aria-checked sur une balise sans rôle, dans un fichier qui en a un ailleurs',
      source: [
        'export const Radio = () => <div ' + ROLE + '"radio" ' + ARIA + '={true} />;',
        'export const T = () => <button ' + ARIA + '={true} />;',
      ].join('\n'),
      raison: /sans rôle cochable/,
    },
    {
      nom: 'la forme dans une seule chaîne',
      source: `export const T = () => <span className="rounded-full translate-x-4" />;`,
      raison: /forme d'interrupteur/,
    },
    {
      nom: 'un pouce posé en left-[…] au lieu de glisser, avec role="checkbox"',
      source: [
        'export const T = ({ on }: { on: boolean }) => (',
        '  <span className="relative inline-flex h-5 w-9 rounded-full bg-ink-4">',
        '    <input type="checkbox" ' + ROLE + '"checkbox" className="sr-only" />',
        '    <span',
        '      className={[',
        "        'absolute h-3.5 w-3.5 rounded-full bg-paper',",
        "        on ? 'left-[19px]' : 'left-[3px]',",
        "      ].join(' ')}",
        '    />',
        '  </span>',
        ');',
      ].join('\n'),
      raison: /voyage entre deux positions/,
    },
    {
      nom: "une case à cocher habillée qui n'écrit que le bout allumé",
      source: [
        'export const T = () => (',
        '  <label className="relative inline-flex">',
        '    <input type="checkbox" className="peer sr-only" />',
        '    <span className="h-5 w-9 rounded-full bg-ink-4" />',
        '    <span className="absolute h-3.5 w-3.5 peer-checked:translate-x-[19px]" />',
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
      nom: 'OptionRadio, dont le rôle cochable est SUR la balise qui porte aria-checked',
      source: [
        'export const T = () => (',
        '  <div',
        '    ' + ROLE + '"radio"',
        '    ' + ARIA + '={active}',
        '    onKeyDown={(e) => handle(e)}',
        '    className="rounded-[10px] border mb-2"',
        '  />',
        ');',
      ].join('\n'),
    },
    {
      nom: "le Select, qui a peer sans dessiner d'interrupteur",
      source: `export const T = () => <select className="peer appearance-none rounded-md" />;`,
    },
    {
      nom: 'la pastille de IconButton, ronde et posée à UNE position pour toujours',
      source: [
        'export const T = () => (',
        '  <button className="rounded-full">',
        '    <span className="absolute top-[6px] right-[7px] h-1.5 w-1.5 rounded-full bg-skill-vivid" />',
        '  </button>',
        ');',
      ].join('\n'),
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
