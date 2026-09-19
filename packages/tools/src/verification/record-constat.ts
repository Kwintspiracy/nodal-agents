// verification/record-constat.ts — ÉCRIRE le constat, pour que l'écran le lise
// au lieu de le refaire (issue #199).
//
// Le bloc Files d'un run reconstruisait sa liste à l'affichage, en relisant les
// lignes `tool_calls` : ce qu'un outil avait NOMMÉ. Une déclaration, donc, et
// pas un constat — un shell qui écrit dix fichiers sans les nommer n'y
// paraissait pas, et un outil qui nomme un fichier sans l'écrire y paraissait.
// Le constat existe déjà côté seam (`observed.ts`, `harness.ts`, `git-constat.ts`) ;
// il ne survivait simplement pas à la fin de l'appel.
//
// Ce module le range dans `constated_writes`, une ligne par fichier, avec son
// genre et LA FAÇON DONT IL A ÉTÉ CONSTATÉ. Ce dernier mot voyage jusqu'à
// l'écran : une liste prise sur le disque ne promet pas ce qu'une liste prise
// dans git promet, et les confondre serait un faux complet (invariant #4).
//
// IL NE LÈVE JAMAIS. Comme `markDeliverablesProduced`, il est appelé depuis le
// seam, DANS le `try` qui entoure l'appel de l'outil : une exception ici
// rendrait un échec d'outil pour une écriture qui a eu lieu. Une panne se dit
// par un code et n'empêche rien.

import { constatedWrites } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { ConstatedBy, ConstatedChangeKind, ConstatedWrite } from '@nodal-agents/shared';
import { normalizePath } from '@nodal-agents/shared';
import { realpath } from 'node:fs/promises';
import { fingerprint, type FileSnapshot } from './observed';

/**
 * LE CHEMIN RÉEL D'UN FICHIER CONSTATÉ, et pourquoi il faut le prendre.
 *
 * Les deux constats ne nomment pas le même fichier de la même façon. Git rend
 * toujours la forme longue et suivie ; un outil de Nodal rend ce que son
 * appelant lui a donné, qui peut être une forme courte 8.3 ou passer par une
 * jonction. Sans cette résolution, le MÊME fichier écrit par un harnais dans un
 * dépôt entre deux fois dans `constated_writes` — une ligne `git`, une ligne
 * `disk` — et le bloc Files le montre deux fois sous deux orthographes.
 *
 * C'est le défaut que la CI Windows a trouvé sur la garde de périmètre du
 * constat par git, dans son chemin jumeau.
 *
 * UN FICHIER SUPPRIMÉ N'A PLUS DE CHEMIN RÉEL : on résout alors son DOSSIER et
 * on lui raccroche son nom. Si le dossier non plus n'existe pas, on garde ce
 * qu'on nous a donné — c'est ce qu'on avait, et inventer serait pire.
 */
export async function cheminConstate(path: string): Promise<string> {
  const p = normalizePath(path);
  try {
    return normalizePath(await realpath(p));
  } catch {
    /* le fichier n'est plus là — son dossier, peut-être */
  }
  const coupe = p.lastIndexOf('/');
  if (coupe <= 0) return p;
  try {
    return `${normalizePath(await realpath(p.slice(0, coupe)))}${p.slice(coupe)}`;
  } catch {
    return p;
  }
}

/** Une ligne prête à ranger : le constat, plus d'où il vient. */
export interface LigneDeConstat extends ConstatedWrite {
  readonly constatedBy: ConstatedBy;
}

/**
 * Le genre d'un fichier constaté SUR LE DISQUE.
 *
 * Ce que l'on sait et ce que l'on ne sait pas. Pour une cible qu'un outil a
 * NOMMÉE, l'état d'avant a été pris (`snapshotFileTargets`) : créé, modifié ou
 * supprimé se lit exactement. Pour un fichier rapporté par un HARNAIS, il n'y
 * a pas d'avant — personne ne savait quel fichier regarder avant que le CLI ne
 * le nomme — et un fichier présent est dit `modified` plutôt que `added`. C'est
 * la borne de `harness.ts`, redite ici : le constat disque est plus faible, et
 * c'est précisément pourquoi le constat par git existe.
 */
export async function kindSurDisque(
  path: string,
  before: FileSnapshot,
): Promise<ConstatedChangeKind> {
  const apres = await fingerprint(path);
  if (apres.kind === 'absent') return 'deleted';
  const avant = before.get(path);
  if (avant === undefined) return 'modified';
  return avant.kind === 'absent' ? 'added' : 'modified';
}

/**
 * Est-ce que ce chemin tombe sous une racine de dépôt CONSTATÉE ?
 *
 * Sert à une seule décision, et elle compte : dans un dépôt, c'est git qui dit
 * la liste, et une ligne disque du même dossier ferait doublon sous un autre
 * mot. Hors de tout dépôt, le constat disque reste le seul qu'on ait.
 *
 * La comparaison est faite en casse repliée : sous Windows, le même dossier
 * s'écrit `D:/Apps/x` et `d:/apps/x`, et une comparaison sensible à la casse
 * ferait passer un fichier du dépôt pour un fichier de dehors.
 */
export function sousUneRacine(path: string, roots: readonly string[]): boolean {
  const p = normalizePath(path).toLowerCase();
  return roots.some((r) => {
    const racine = normalizePath(r).toLowerCase();
    return p === racine || p.startsWith(`${racine}/`);
  });
}

/**
 * Range les lignes du constat de CE tour.
 *
 * `onConflictDoNothing` sur (job, tour, chemin) : un fichier écrit par deux
 * commandes du même tour est UN fichier livré. Le premier constat gagne — il
 * dit déjà que ce fichier a bougé, et c'est tout ce que l'écran montre.
 *
 * Rend le nombre de lignes présentées, jamais une erreur.
 */
export async function recordConstatedWrites(input: {
  readonly db: AnyDrizzleDb;
  readonly jobId: string | null | undefined;
  readonly turn: number | null | undefined;
  readonly lignes: readonly LigneDeConstat[];
}): Promise<number> {
  const { db, jobId, lignes } = input;
  // Sans job, il n'y a pas de run à qui rattacher le constat — un appel d'outil
  // hors boucle de travail (un test, un tour de chat). Rien à ranger, et rien
  // d'anormal : on ne journalise pas un cas normal.
  if (!jobId || lignes.length === 0) return 0;
  const turn = input.turn ?? 0;
  const vus = new Set<string>();
  const values = [];
  for (const l of lignes) {
    // Le chemin RÉEL, pour que deux orthographes du même fichier ne fassent
    // pas deux lignes — voir `cheminConstate`.
    const path = await cheminConstate(l.path);
    if (vus.has(path)) continue;
    vus.add(path);
    values.push({
      jobId,
      turn,
      path,
      changeKind: l.kind,
      constatedBy: l.constatedBy,
      renamedFrom: l.renamedFrom ?? null,
    });
  }
  try {
    await db.insert(constatedWrites).values(values).onConflictDoNothing();
    return values.length;
  } catch (err) {
    console.warn(`[verification] CONSTAT_WRITE_FAILED job=${jobId} turn=${turn}`, err);
    return 0;
  }
}
