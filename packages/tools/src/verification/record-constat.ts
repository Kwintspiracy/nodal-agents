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
// LE CONSTAT D'UN OUTIL NE LÈVE JAMAIS. Comme `markDeliverablesProduced`, il
// est appelé depuis le seam, DANS le `try` qui entoure l'appel de l'outil : une
// exception ici rendrait un échec d'outil pour une écriture qui a eu lieu. Une
// panne se dit par un code et n'empêche rien. Une écriture de la PLATEFORME
// pour un job (`recordPlatformWrites`, #913) passe par le même rangement, et
// elle lève : l'appelant ne promet pas au job un fichier qu'il n'a pas rangé.

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
export async function constatSurDisque(
  path: string,
  before: FileSnapshot,
): Promise<ConstatedWrite> {
  const apres = await fingerprint(path);
  if (apres.kind === 'absent') return { path, kind: 'deleted' };
  const avant = before.get(path);
  const kind: ConstatedChangeKind =
    avant === undefined ? 'modified' : avant.kind === 'absent' ? 'added' : 'modified';
  // L'empreinte d'APRÈS l'appel (#919), lue ici de toute façon pour décider du
  // genre : l'identité exacte du contenu que le constat a vu, gratuite. Un
  // fichier illisible n'en a pas — son identité reste inconnue, et c'est dit
  // là où elle sert (`apps/runner/src/verification/removed.ts`).
  return apres.kind === 'file' ? { path, kind, observedSha256: apres.sha256 } : { path, kind };
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

/** Ce que `rangerConstats` range : le job, son tour, les lignes et les empreintes écrites. */
interface ConstatsARanger {
  readonly db: AnyDrizzleDb;
  readonly jobId: string | null | undefined;
  readonly turn: number | null | undefined;
  readonly lignes: readonly LigneDeConstat[];
  /**
   * L'empreinte des OCTETS que l'outil a écrits, par chemin (#505,
   * `ctx.reportWrittenContent`). Un chemin absent de cette carte n'a pas
   * d'empreinte : une écriture que l'outil n'a pas décrite (shell, harnais)
   * n'accorde aucune propriété. Les outils Office la rapportent depuis #780
   * (`writeWorkspaceBinary`), comme les outils fichier.
   */
  readonly contenusEcrits?: ReadonlyMap<string, string>;
}

/**
 * Range les lignes du constat de CE tour.
 *
 * `onConflictDoNothing` sur (job, tour, chemin) : un fichier écrit par deux
 * commandes du même tour est UN fichier livré. Le premier constat gagne — il
 * dit déjà que ce fichier a bougé, et c'est tout ce que l'écran montre.
 *
 * Rend le nombre de lignes présentées, jamais une erreur : le seam l'appelle
 * après une écriture qui a eu lieu (voir l'en-tête).
 */
export async function recordConstatedWrites(input: ConstatsARanger): Promise<number> {
  try {
    return await rangerConstats(input);
  } catch (err) {
    console.warn(
      `[verification] CONSTAT_WRITE_FAILED job=${input.jobId} turn=${input.turn ?? 0}`,
      err,
    );
    return 0;
  }
}

/**
 * Le tour des écritures que la PLATEFORME fait pour un job hors de tout appel
 * d'outil (#913) : un fichier reçu par un canal, un fichier qu'un outil a rendu
 * et que le runner range pour le modèle. Le compteur du runner part de 0 et le
 * premier tour du modèle est 1 : aucun appel d'outil ne porte ce tour, donc
 * aucune commande n'est dite « certaine » (`classifyProduction`, apps/web) sur
 * la foi d'une écriture qu'elle n'a pas faite.
 */
export const PLATFORM_WRITE_TURN = 0;

/**
 * Une écriture que la plateforme a faite POUR un job (#913) : rangée comme
 * celle d'un outil, par la même fonction, avec l'empreinte des octets écrits.
 * La porte d'écrasement du dossier partagé (`currentContentWrittenByJob`) la
 * lit donc comme le travail de CE job : un fichier reçu pour lui se range sans
 * demander à personne, tant que son contenu est celui que la plateforme a
 * écrit. Un autre job qui le réécrit, une personne qui l'édite : la porte
 * redemande.
 *
 * LÈVE, contrairement à `recordConstatedWrites` : l'appelant écrit le fichier
 * pour le job, et un fichier dont l'écriture n'a pas été rangée ne doit pas
 * lui être promis en silence (invariant #4). `db` peut être une transaction.
 */
export async function recordPlatformWrites(input: {
  readonly db: AnyDrizzleDb;
  readonly jobId: string;
  /** Chaque fichier écrit : son chemin absolu et l'empreinte sha256 des octets écrits. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}): Promise<void> {
  await rangerConstats({
    db: input.db,
    jobId: input.jobId,
    turn: PLATFORM_WRITE_TURN,
    lignes: input.files.map((f) => ({
      path: f.path,
      kind: 'added' as const,
      constatedBy: 'disk' as const,
    })),
    contenusEcrits: new Map(input.files.map((f) => [f.path, f.sha256])),
  });
}

/** Le rangement lui-même, commun aux deux : il lève. */
async function rangerConstats(input: ConstatsARanger): Promise<number> {
  const { db, jobId, lignes } = input;
  // Sans job, il n'y a pas de run à qui rattacher le constat — un appel d'outil
  // hors boucle de travail (un test, un tour de chat). Rien à ranger, et rien
  // d'anormal : on ne journalise pas un cas normal.
  if (!jobId || lignes.length === 0) return 0;
  const turn = input.turn ?? 0;
  // Les clés des empreintes ramenées au chemin RÉEL, comme les lignes.
  const empreintes = new Map<string, string>();
  for (const [chemin, sha] of input.contenusEcrits ?? []) {
    empreintes.set(await cheminConstate(chemin), sha);
  }
  // Une ligne par chemin réel. Deux lignes du même appel pour le même chemin
  // décrivent le MÊME état d'après (#919, revue A passe 5) : la première
  // garde son genre et sa source (git avant disque, `fusionnerConstats`), et
  // l'empreinte observée vient de n'importe laquelle des deux — jamais perdue
  // parce qu'une ligne sans empreinte est arrivée la première.
  const vues = new Map<string, { observedSha256: string | null }>();
  const values = [];
  for (const l of lignes) {
    // Le chemin RÉEL, pour que deux orthographes du même fichier ne fassent
    // pas deux lignes — voir `cheminConstate`.
    const path = await cheminConstate(l.path);
    const deja = vues.get(path);
    if (deja) {
      if (deja.observedSha256 === null && l.kind !== 'deleted') {
        deja.observedSha256 = l.observedSha256 ?? null;
      }
      continue;
    }
    // L'empreinte de ce que l'outil a ÉCRIT (revue Codex de #505, passes 1 et
    // 2) : c'est elle que la porte d'écrasement compare au disque, jamais
    // l'ordre des lignes, ni une relecture du disque faite ici — un autre
    // écrivain a pu passer entre l'écriture et ce constat.
    const empreinte = l.kind === 'deleted' ? null : (empreintes.get(path) ?? null);
    const ligne = {
      jobId,
      turn,
      path,
      changeKind: l.kind,
      constatedBy: l.constatedBy,
      renamedFrom: l.renamedFrom ?? null,
      contentSha256: empreinte,
      // Ce que le constat a VU après l'appel (#919) : l'identité du contenu,
      // jamais une propriété — la porte d'écrasement lit `contentSha256` seul.
      observedSha256: l.kind === 'deleted' ? null : (l.observedSha256 ?? null),
    };
    vues.set(path, ligne);
    values.push(ligne);
  }
  // Le même fichier réécrit dans le MÊME tour reste une ligne (l'unicité de
  // #199), mais son empreinte suit la DERNIÈRE écriture : sinon la porte
  // comparerait le disque au premier jet et redemanderait pour le troisième.
  await db
    .insert(constatedWrites)
    .values(values)
    .onConflictDoUpdate({
      target: [constatedWrites.jobId, constatedWrites.turn, constatedWrites.path],
      set: {
        contentSha256: sql`excluded.content_sha256`,
        observedSha256: sql`excluded.observed_sha256`,
      },
    });
  return values.length;
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
  const lignes = await db
    .select({ jobId: constatedWrites.jobId, sha: constatedWrites.contentSha256 })
    .from(constatedWrites)
    .where(eq(constatedWrites.path, await cheminConstate(absPath)))
    .orderBy(desc(constatedWrites.createdAt));
  // Le disque EN DERNIER (revue Codex de #505, passe 3) : l'écriture atomique
  // remplace le fichier juste après cette réponse, et rien — ni la requête en
  // base, ni la résolution du chemin — ne doit plus séparer la lecture du
  // contenu du `rename`. Tout ce qui suit est synchrone.
  const actuel = await fingerprint(absPath);
  if (actuel.kind !== 'file') return false;
  const derniereDuJob = lignes.find((l) => l.jobId === jobId);
  if (derniereDuJob?.sha !== actuel.sha256) return false;
  return !lignes.some((l) => l.jobId !== jobId && l.sha === actuel.sha256);
}
