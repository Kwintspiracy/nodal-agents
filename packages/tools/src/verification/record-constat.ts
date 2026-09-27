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

import { constatedWrites, desc, eq, sql } from '@nodal-agents/db';
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
 * LES DEUX CONSTATS S'AJOUTENT — l'un ne remplace jamais l'autre.
 *
 * Revue C de la PR #227, constat 2. Une première version écartait toute ligne
 * DISQUE tombant sous une racine constatée par git, au motif que dans un dépôt
 * c'est git qui dit la liste. C'était faux pour ce que git NE VOIT PAS : un
 * fichier nommé par un outil ou rapporté par un harnais sous un chemin ignoré
 * (`dist/x.js`) n'est dans aucune des deux listes dès qu'un autre fichier,
 * suivi celui-là, a bougé dans le même run — donc présent ou absent du bloc
 * Files selon ce qu'un AUTRE fichier a fait. La règle de #196 est pourtant
 * entière : une cible NOMMÉE se constate sur le disque, toujours.
 *
 * L'ORDRE EST LE FOND : git d'abord. `recordConstatedWrites` range par chemin
 * réel et garde la première ligne, donc un fichier vu des deux côtés reste UNE
 * ligne, dite `git` — le constat le plus fort gagne, sans que la liste perde
 * personne.
 */
export function fusionnerConstats(input: {
  readonly git: readonly ConstatedWrite[];
  readonly disque: ReadonlyArray<ConstatedWrite>;
}): LigneDeConstat[] {
  return [
    ...input.git.map((w) => ({ ...w, constatedBy: 'git' as const })),
    ...input.disque.map((w) => ({ ...w, constatedBy: 'disk' as const })),
  ];
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
    // L'empreinte de ce que l'écriture a LAISSÉ (revue Codex de #505) : c'est
    // elle que la porte d'écrasement compare au disque, jamais l'ordre des
    // lignes. Une suppression ou un fichier illisible n'en a pas.
    const apres = l.kind === 'deleted' ? null : await fingerprint(path);
    values.push({
      jobId,
      turn,
      path,
      changeKind: l.kind,
      constatedBy: l.constatedBy,
      renamedFrom: l.renamedFrom ?? null,
      contentSha256: apres?.kind === 'file' ? apres.sha256 : null,
    });
  }
  try {
    // Le même fichier réécrit dans le MÊME tour reste une ligne (l'unicité de
    // #199), mais son empreinte suit la DERNIÈRE écriture : sinon la porte
    // comparerait le disque au premier jet et redemanderait pour le troisième.
    await db
      .insert(constatedWrites)
      .values(values)
      .onConflictDoUpdate({
        target: [constatedWrites.jobId, constatedWrites.turn, constatedWrites.path],
        set: { contentSha256: sql`excluded.content_sha256` },
      });
    return values.length;
  } catch (err) {
    console.warn(`[verification] CONSTAT_WRITE_FAILED job=${jobId} turn=${turn}`, err);
    return 0;
  }
}

/**
 * Le contenu ACTUEL de ce fichier est-il celui que CE job y a écrit ?
 * (issue #505, revue Codex P1-a et P1-b)
 *
 * C'est la question que pose la porte d'écrasement du dossier partagé : elle
 * protège le travail d'un AUTRE, et un run qui réécrit le fichier qu'il vient
 * de produire n'écrase le travail de personne. Job 8c763150 : six voix off
 * régénérées aux mêmes chemins, six demandes d'approbation pour un travail
 * qui était le sien.
 *
 * La réponse se lit sur le CONTENU, pas sur l'ordre des lignes :
 *
 *  - l'empreinte actuelle du fichier doit égaler celle de la dernière écriture
 *    constatée de CE job. Une édition faite hors de Nodal (une personne, un
 *    CLI, une restauration) ne laisse aucun constat, mais elle change
 *    l'empreinte : la porte redemande ;
 *  - aucun AUTRE job ne doit avoir constaté ce même contenu à ce chemin. Les
 *    constats sont rangés APRÈS l'écriture, dans un ordre qui n'est pas celui
 *    des écritures : un run qui range son constat après qu'un autre a réécrit
 *    le fichier y lit le contenu de l'autre. Ce contenu porte alors deux noms,
 *    et un contenu qui n'est pas prouvablement le nôtre se protège.
 *
 * Fichier absent, illisible, ou constat sans empreinte (suppression, ligne
 * d'avant 0131) : pas de propriété, la porte demande.
 */
export async function currentContentWrittenByJob(
  db: AnyDrizzleDb,
  jobId: string | null | undefined,
  absPath: string,
): Promise<boolean> {
  if (!jobId) return false;
  const actuel = await fingerprint(absPath);
  if (actuel.kind !== 'file') return false;
  const lignes = await db
    .select({ jobId: constatedWrites.jobId, sha: constatedWrites.contentSha256 })
    .from(constatedWrites)
    .where(eq(constatedWrites.path, await cheminConstate(absPath)))
    .orderBy(desc(constatedWrites.createdAt));
  const derniereDuJob = lignes.find((l) => l.jobId === jobId);
  if (derniereDuJob?.sha !== actuel.sha256) return false;
  return !lignes.some((l) => l.jobId !== jobId && l.sha === actuel.sha256);
}
