// constated-files.ts — LA LISTE DU BLOC FILES VIENT DU CONSTAT, pas de ce que
// l'agent a déclaré (issue #199).
//
// Avant, le bloc Files se construisait entièrement à l'affichage : on relisait
// les lignes `tool_calls`, on en tirait les fichiers qu'un outil avait NOMMÉS,
// et cette liste-là était présentée comme « les fichiers livrés du run ». Deux
// erreurs symétriques en sortaient. Un `run_command` qui écrit dix fichiers
// sans les nommer n'en montrait aucun. Un outil qui nomme un fichier sans
// l'écrire — un `file_edit` dont le fragment est introuvable — le montrait
// quand même.
//
// Le seam constate maintenant, et range son constat (`constated_writes`). Ce
// module fait la jonction : la LISTE vient des lignes du constat, le CONTENU
// (les fragments avant/après, les compteurs de churn) vient des appels d'outils
// qui ont nommé le même fichier. Un fichier que git a vu et qu'aucun outil n'a
// nommé paraît donc, sans diff — c'est justement le fichier qu'on ne voyait
// pas.
//
// UN RUN SANS AUCUNE LIGNE DE CONSTAT GARDE SA LISTE DÉCLARÉE. Les runs
// d'avant la migration 0113 n'en ont pas, et les faire disparaître d'un coup
// serait une perte de trace, pas une correction. Le mot rendu par
// `labelDuConstat` le dit alors : déclaré, pas constaté.

import { canonicalChangePath } from './coding-changes.ts';
import type { ConstatedBy, ConstatedChangeKind } from '@nodal-agents/shared';

/** Une ligne de `constated_writes`, telle que l'action la lit. */
export interface ConstatRow {
  readonly path: string;
  readonly changeKind: ConstatedChangeKind;
  readonly constatedBy: ConstatedBy;
  readonly renamedFrom: string | null;
}

/** Le minimum qu'un groupe de changements doit porter pour être rapproché. */
export interface GroupeRapprochable {
  readonly filePath: string;
}

/**
 * Rapproche les lignes du constat des groupes déclarés.
 *
 * L'ORDRE EST CELUI DU CONSTAT, dédoublonné sur le chemin canonique : c'est
 * l'ordre dans lequel le run a écrit, et le seul que la personne puisse
 * recouper avec ce qu'elle voit dans son dossier.
 *
 * LE RAPPROCHEMENT EST FAIT EN CASSE REPLIÉE. Sous Windows, `D:/Apps/x/A.ts`
 * écrit par git et `a.ts` écrit par un outil désignent le même fichier, et une
 * comparaison sensible à la casse le montrerait deux fois — une fois avec son
 * diff, une fois sans.
 */
export function rapprocherConstat<G extends GroupeRapprochable>(input: {
  readonly rows: readonly ConstatRow[];
  readonly declared: readonly G[];
  readonly workspaceRoots: readonly string[];
}): Array<{ filePath: string; changeKind: ConstatedChangeKind; declared: G | null }> {
  const parChemin = new Map<string, G>();
  for (const g of input.declared) {
    const cle = g.filePath.toLowerCase();
    if (!parChemin.has(cle)) parChemin.set(cle, g);
  }
  const vus = new Set<string>();
  const out: Array<{ filePath: string; changeKind: ConstatedChangeKind; declared: G | null }> = [];
  for (const row of input.rows) {
    const canonique = canonicalChangePath(row.path, input.workspaceRoots);
    const cle = canonique.toLowerCase();
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push({
      filePath: canonique,
      changeKind: row.changeKind,
      declared: parChemin.get(cle) ?? null,
    });
  }
  return out;
}

/**
 * Les façons dont ce run a été constaté, dédoublonnées et ordonnées.
 *
 * Un run peut porter les deux : un `file_write` nommé (constaté sur le disque)
 * puis un `run_command` dans un dépôt (constaté par git). Les fondre en un seul
 * mot ferait passer une moitié de liste pour l'autre.
 */
export function faconsDeConstater(rows: readonly ConstatRow[]): ConstatedBy[] {
  const out: ConstatedBy[] = [];
  if (rows.some((r) => r.constatedBy === 'git')) out.push('git');
  if (rows.some((r) => r.constatedBy === 'disk')) out.push('disk');
  return out;
}

/**
 * Le mot du pied de bloc — ce qui fait foi pour cette liste.
 *
 * En anglais, comme tout ce que l'écran montre. Il n'y a pas de cas muet :
 * une absence de constat se dit (invariant #4), sans quoi une liste déclarée
 * se lirait comme une liste constatée.
 */
export function labelDuConstat(facons: readonly ConstatedBy[]): string {
  const git = facons.includes('git');
  const disk = facons.includes('disk');
  if (git && disk) return 'Constated by git, and on disk for the files outside a repository';
  if (git) return 'Constated by git: the delta of git status around each run';
  if (disk) return 'Constated on disk: the files the tools named, read before and after';
  return 'Declared by the tools, not constated';
}
