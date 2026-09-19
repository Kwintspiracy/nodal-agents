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
// Trois faits refusés, chacun étant une façon réelle de rouvrir le trou :
//   1. `role="switch"` ailleurs que dans `ui/Switch.tsx` — un interrupteur
//      dessiné à la main ;
//   2. une chaîne de classes qui porte À LA FOIS `translate-x` et
//      `rounded-full` — la forme d'un interrupteur, même sans le rôle ARIA.
//      Le tiroir du Sidebar glisse aussi (`-translate-x-full`) mais n'est pas
//      rond : il ne tombe pas là-dedans, et c'est le but du ET ;
//   3. `trackClassName` / `thumbClassName` — la porte par laquelle une couleur
//      d'appelant revenait dans le composant.
//
// Mutations vérifiées : le filtre sur `ui/Switch.tsx` retiré → la garde rougit
// sur le composant lui-même (elle regarde donc vraiment les fichiers) ; le ET
// de la règle 2 remplacé par un OU → elle rougit sur le tiroir du Sidebar
// (elle distingue donc une forme d'interrupteur d'une simple translation) ;
// `thumbClassName` rendu à un appelant → la règle 3 rougit.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Le seul fichier autorisé à dessiner un interrupteur. */
const LE_COMPOSANT = join('components', 'ui', 'Switch.tsx');

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

const FICHIERS = sources(SRC_DIR)
  .map((p) => ({ chemin: relative(SRC_DIR, p), texte: readFileSync(p, 'utf8') }))
  .filter(({ chemin }) => !estUnTest(chemin));

/** Chaque chaîne de classes du fichier : littéraux `"…"` / `'…'` et gabarits. */
function chainesDeClasses(texte: string): string[] {
  return [...texte.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((m) => m[2]!);
}

describe('architecture — un seul composant Switch dessine un interrupteur (#236)', () => {
  it('la garde regarde bien tout le dossier source', () => {
    // Sans ce fait, une erreur de chemin rendrait les trois suivants verts
    // pour la seule raison qu'ils ne regardent rien.
    expect(FICHIERS.length).toBeGreaterThan(200);
    expect(FICHIERS.some(({ chemin }) => chemin === LE_COMPOSANT)).toBe(true);
  });

  it('aucun autre fichier ne pose role="switch"', () => {
    const role = 'role=' + '"switch"';
    const coupables = FICHIERS.filter(
      ({ chemin, texte }) => chemin !== LE_COMPOSANT && texte.includes(role),
    ).map(({ chemin }) => chemin);
    expect(coupables).toEqual([]);
  });

  it('aucun autre fichier ne dessine la forme (translate-x + rounded-full)', () => {
    const coupables = FICHIERS.filter(
      ({ chemin, texte }) =>
        chemin !== LE_COMPOSANT &&
        chainesDeClasses(texte).some(
          (c) => c.includes('translate-x') && c.includes('rounded-full'),
        ),
    ).map(({ chemin }) => chemin);
    expect(coupables).toEqual([]);
  });

  it('plus personne ne passe la couleur de la piste ou du bouton', () => {
    const coupables = FICHIERS.filter(
      ({ texte }) => texte.includes('trackClassName') || texte.includes('thumbClassName'),
    ).map(({ chemin }) => chemin);
    expect(coupables).toEqual([]);
  });
});
