// projects/markers.ts — les deux gestes de DISQUE dont la règle « ce chemin
// appartient à quel projet » a besoin, posés une seule fois.
//
// POURQUOI CE MODULE. `resolveProjectRoots` (@nodal-agents/shared) est une
// fonction PURE : elle n'a pas le droit d'importer `node:fs` (le paquet est
// bundlé côté client). Ses deux dépendances au disque sont donc injectées par
// l'appelant — et il y a désormais DEUX appelants dans ce paquet : l'intention
// de mutation (verification/intent.ts, la garde) et le registre des projets
// (projects/attach.ts, P5b). Deux copies de `hasMarker` auraient suffi à ce
// que la garde voie un projet là où le registre n'en voit aucun, sans qu'aucun
// écran ne montre le désaccord — exactement ce que le commentaire de
// project-roots.ts dit vouloir éviter.

import { existsSync, realpathSync } from 'node:fs';
import { PROJECT_MARKERS, normalizePath, type MutationTarget } from '@nodal-agents/shared';

/** Le manifeste d'un dossier, lu sur le disque (injecté dans le résolveur pur). */
export function hasMarker(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((m) => existsSync(`${dir}/${m}`));
  } catch {
    return false;
  }
}

/**
 * Le chemin RÉEL d'un dossier ou d'un fichier, normalisé — pour COMPARER,
 * jamais pour nommer (voir `rebaseOntoLexicalRoots`).
 *
 * Un chemin qui N'EXISTE PLUS (un fichier écrit puis supprimé dans le même
 * tour, revue Codex passe 33) est ramené à son ancêtre EXISTANT le plus
 * proche, résolu, puis le reste est rappendu tel quel — la même règle que la
 * contenance physique de Spaces (`project-actions.ts`). Sans ça, un chemin
 * sous un alias (`C:/DEVELO~1/app`, une jonction) restait sous son alias dès
 * que sa feuille avait disparu, ne tombait plus sous aucune racine réelle, et
 * la production n'était ni déclarée ni rattachée.
 */
export function realPathOf(p: string): string {
  const normalized = normalizePath(p);
  try {
    return normalizePath(realpathSync.native(normalized));
  } catch {
    // absent, ou alias d'un chemin absent : on remonte.
  }
  let current = normalized;
  const tail: string[] = [];
  for (;;) {
    const idx = current.lastIndexOf('/');
    // Plus d'ancêtre à essayer (racine POSIX, ou chemin sans séparateur).
    if (idx <= 0) return normalized;
    tail.unshift(current.slice(idx + 1));
    current = current.slice(0, idx);
    // `C:` seul désignerait le dossier courant du lecteur, pas sa racine.
    const probe = /^[a-z]:$/i.test(current) ? `${current}/` : current;
    try {
      const real = normalizePath(realpathSync.native(probe)).replace(/\/$/, '');
      return `${real}/${tail.join('/')}`;
    } catch {
      // cet ancêtre n'existe pas non plus : un cran plus haut.
    }
  }
}

/**
 * Ramène chaque cible sous la racine attachée TELLE QUE L'OWNER L'A ÉCRITE.
 *
 * Les cibles arrivent des outils par `resolveAndCheckPath`, qui passe par
 * `realpath` ; les racines attachées arrivent lexicales. Sur un runner GitHub
 * Windows, `os.tmpdir()` rend la forme courte 8.3 (`C:\Users\RUNNER~1\…`)
 * alors que `realpath` rend la longue — une jonction ou un lien symbolique
 * font pareil partout. Comparées telles quelles, la cible n'était « dans »
 * aucune racine : aucun projet, aucune intention, et l'écriture partait sans
 * être vue (CI rouge de la PR #46, verte en local).
 *
 * La comparaison se fait donc sur les chemins RÉELS, mais l'identité rendue
 * est la LEXICALE : l'onglet Code dérive ses projets des racines telles
 * qu'elles sont enregistrées (apps/web/src/lib/code-projects.ts) et ne résout
 * ni lien ni jonction. Nommer le projet par sa forme réelle créerait deux
 * lignes `code_projects` pour un même dossier — l'état sale d'un côté, les
 * commandes approuvées de l'autre (revue Codex PR #46, passe 2). Une cible
 * hors de toute racine reste telle quelle : le résolveur la rejettera.
 *
 * PARTAGÉE depuis P5b : le registre dérive ses racines des MÊMES cibles que
 * l'intention et doit tomber sur la MÊME clé, sinon l'upsert du registre
 * créerait une seconde ligne `code_projects` pour le dossier que l'intention
 * vient de salir.
 */
export function rebaseOntoLexicalRoots(
  targets: readonly MutationTarget[],
  lexicalRoots: readonly string[],
): readonly MutationTarget[] {
  // La racine la plus SPÉCIFIQUE gagne — la plus longue en chemin réel. Deux
  // racines peuvent se contenir (un lien vers un conteneur, et un projet du
  // conteneur attaché à part) : l'outil a résolu la cible sous la plus
  // profonde, et c'est sous celle-là que l'onglet Code la rattache. Prendre
  // la première dans l'ordre de configuration nommerait le projet par
  // l'autre racine (revue Codex PR #46, passe 3).
  //
  // UNE seule règle, sur les chemins RÉELS uniquement (revue passe 4) : un
  // raccourci « déjà sous une racine lexicale » laissait une racine réelle
  // parente court-circuiter une racine LIÉE plus spécifique. Ce que cette
  // règle ne peut pas décider : deux racines qui recouvrent le même dossier
  // physique donnent deux identités selon le LABEL que l'agent a employé —
  // et l'onglet Code fait de même. C'est un choix de produit (interdire les
  // racines qui se recouvrent, ou accepter deux identités), pas une règle de
  // plus ici.
  const roots = lexicalRoots
    .map((lexical) => ({ lexical, real: realPathOf(lexical) }))
    .sort((a, b) => b.real.length - a.real.length);
  return targets.map((t) => {
    const real = realPathOf(t.path);
    for (const root of roots) {
      if (real === root.real) return { ...t, path: root.lexical };
      if (real.startsWith(`${root.real}/`)) {
        return { ...t, path: `${root.lexical}${real.slice(root.real.length)}` };
      }
    }
    return t;
  });
}
