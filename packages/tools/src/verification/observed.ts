// verification/observed.ts — « ce fichier a-t-il RÉELLEMENT changé ? », constaté
// sur le disque, pas déduit d'une déclaration.
//
// Issue #60, résidu assumé de la PR #49. Un livrable était marqué `produced`
// sur la foi de l'outil : il avait NOMMÉ une cible et n'avait pas déclaré
// d'échec. Un outil qui annonce avoir écrit sans avoir écrit passait donc pour
// avoir produit — et `declare_verification` lui accordait le droit de dire
// comment on vérifie ce projet. Ni le code de sortie d'un shell (`robocopy`
// rend 1 quand il a copié) ni l'instantané de checkpoint (pris une fois par
// tour, `dist/` exclu) ne pouvaient trancher.
//
// Ce module tranche pour les cibles FICHIER, et pour elles seules : on prend
// l'état du fichier avant l'outil (existence, taille, empreinte du CONTENU),
// on le reprend après, et une différence est une écriture constatée.
//
// UNE CIBLE DOSSIER NE CRÉDITE RIEN (issue #102). Le `cwd` d'un shell, le
// périmètre d'écriture d'un tour de harnais : rien n'en est lu sur le disque,
// donc rien n'y est constaté. La première version créditait quand même le
// projet du dossier, sur la foi de la cible seule — une commande qui n'écrivait
// pas un octet posait `produced`, et `declare_verification` lui accordait
// ensuite le droit de dire comment ce projet se vérifie. C'était le trou que
// #60 avait fermé pour les fichiers, resté ouvert pour la surface shell.
//
// Ce que ce module ne fait PAS, et le dit : constater ce qu'un shell a écrit
// sous un dossier demanderait un instantané de l'arbre à chaque commande. Le
// coût est toute la question — une marche complète est hors de question sur un
// gros dépôt, et toute approximation bon marché (mtime du dossier, une
// profondeur, une liste d'exclusions) serait un trou de plus qu'il faudrait
// nommer. En attendant, l'absence est VISIBLE plutôt que comblée : le livrable
// reste `produced = false`, la ligne de journal le dit par un code, et
// `declare_verification` refuse en nommant le fait au lieu d'accuser une panne
// qui n'a pas eu lieu. Un faux vert est devenu une absence dite (invariant #4).
//
// LE CONTENU, PAS LA DATE (revue Codex post-merge de la PR #75, constat 3).
// La première empreinte était `{ size, mtimeNs }`, et ces lignes annonçaient un
// seul trou : « un contenu réécrit à l'identique dans la même nanoseconde ».
// C'était faux. `mtimeNs` PORTE des nanosecondes, il ne les mesure pas : la
// résolution est celle du système de fichiers, et elle va de la nanoseconde à
// deux secondes (FAT), en passant par la seconde de plusieurs montages réseau.
// Une réécriture de même taille dans cette fenêtre passait pour « rien n'a
// changé » et laissait `produced` faux sur un fichier bel et bien écrit — un
// faux rouge, puis le refus de `declare_verification` derrière.
//
// Le prix est une lecture complète du fichier de chaque côté de l'appel. Il est
// payé sciemment : les cibles FICHIER sont celles que l'outil a nommées, elles
// se comptent sur les doigts, et un plafond de taille serait un trou de plus à
// ne pas dire. C'est la même décision que `fileStamp` côté vérificateur de
// document (constat C1 de la PR #66).
//
// Ce qui n'est PAS constaté : un contenu réécrit à L'IDENTIQUE. Rien ne l'a
// changé, pour qui lit le fichier.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { MutationTarget, ProjectRoot } from '@nodal-agents/shared';
import { resolveProjectRoots } from '@nodal-agents/shared';
import { rebaseOntoLexicalRoots } from '../projects/markers';
import { officeFileDeliverables } from './office-file-key';

/**
 * L'empreinte d'un fichier à un instant — TROIS états, pas deux.
 *
 * `unreadable` existe parce que lire le contenu peut échouer là où `stat`
 * réussit : un verrou, un droit retiré, un montage qui tombe. Le confondre avec
 * `absent` — ce que faisait la première version de cette empreinte — faisait
 * d'une lecture refusée une ÉCRITURE constatée, donc un faux vert, et de deux
 * lectures refusées un silence sur une écriture réelle (revue Codex de la dette
 * de la PR #75, passe 2, constat 2 : un trou ouvert par le correctif de la
 * passe 1). La taille est gardée quand `stat` a répondu : elle se lit sans
 * ouvrir le fichier, et c'est tout ce qu'on peut encore constater.
 */
export type FileFingerprint =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly size: bigint; readonly sha256: string }
  | { readonly kind: 'unreadable'; readonly size: bigint | null };

export type FileSnapshot = ReadonlyMap<string, FileFingerprint>;

const ABSENT: FileFingerprint = { kind: 'absent' };

/**
 * « Ce fichier n'est pas là » — la SEULE erreur qui réponde à la question posée.
 *
 * Les autres (`EACCES`, `EPERM`, `EBUSY`, un montage tombé) ne disent rien de
 * son existence, et les ranger dans « absent » faisait d'un refus d'ÉTAT une
 * écriture constatée : le troisième état distinguait le refus de LIRE, pas
 * celui de `stat` (revue Codex de la dette de la PR #75, passe 3, constat 1).
 * `ENOTDIR` compte aussi : un segment du chemin n'est plus un dossier, donc ce
 * fichier-là n'est plus.
 */
function estAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Exportée depuis le 19/09 pour le constat par git (`git-constat.ts`) : les
 * deux modules posent la MÊME question — ce fichier a-t-il changé ? — et
 * doivent y répondre par la même empreinte. La recopier aurait fait diverger
 * les deux constats au premier correctif porté d'un seul côté, et ce sont
 * justement les trois états de cette empreinte (dont `unreadable`, dont
 * l'absence avait coûté un faux vert PUIS un faux rouge) qui ont demandé trois
 * passes de revue.
 */
export async function fingerprint(path: string): Promise<FileFingerprint> {
  let size: bigint;
  try {
    const s = await stat(path, { bigint: true });
    if (!s.isFile()) return ABSENT;
    size = s.size;
  } catch (error) {
    return estAbsence(error) ? ABSENT : { kind: 'unreadable', size: null };
  }
  try {
    const bytes = await readFile(path);
    return { kind: 'file', size, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { kind: 'unreadable', size };
  }
}

/** L'état des cibles FICHIER avant l'outil. Les dossiers ne sont pas pris. */
export async function snapshotFileTargets(
  targets: readonly MutationTarget[],
): Promise<FileSnapshot> {
  const out = new Map<string, FileFingerprint>();
  for (const t of targets) {
    if (t.kind !== 'file' || out.has(t.path)) continue;
    out.set(t.path, await fingerprint(t.path));
  }
  return out;
}

/**
 * Les cibles FICHIER dont l'empreinte a changé depuis l'instantané.
 *
 * Quand un des deux côtés n'a pas pu être LU, il n'y a rien à constater : la
 * seule chose qui reste est la taille, quand `stat` a répondu des deux côtés.
 * À défaut, la cible n'est pas créditée et la ligne est DITE — pas devinée
 * dans un sens ou dans l'autre (invariant nº 4).
 */
export async function changedFileTargets(
  targets: readonly MutationTarget[],
  before: FileSnapshot,
): Promise<MutationTarget[]> {
  const out: MutationTarget[] = [];
  for (const t of targets) {
    if (t.kind !== 'file') continue;
    const was = before.get(t.path) ?? ABSENT;
    const now = await fingerprint(t.path);
    if (was.kind === 'unreadable' || now.kind === 'unreadable') {
      const tailleAvant = was.kind === 'absent' ? null : was.size;
      const tailleApres = now.kind === 'absent' ? null : now.size;
      if (tailleAvant !== null && tailleApres !== null && tailleAvant !== tailleApres) {
        out.push(t);
        continue;
      }
      console.warn(`[verification] VERIFICATION_OBSERVE_UNREADABLE path=${t.path}`);
      continue;
    }
    const same =
      (was.kind === 'absent' && now.kind === 'absent') ||
      (was.kind === 'file' &&
        now.kind === 'file' &&
        was.size === now.size &&
        was.sha256 === now.sha256);
    if (!same) out.push(t);
  }
  return out;
}

/**
 * Les clés de livrables qu'une écriture CONSTATÉE soutient — la même règle de
 * nommage que l'intention, sans expansion : ce sont les livrables VISÉS qui
 * comptent ici, jamais le périmètre de précaution.
 *
 * Les cibles DOSSIER n'en font plus partie (issue #102) : rien n'est lu sous
 * un dossier, donc rien n'y est constaté. Elles restent demandées en entrée
 * parce que l'appelant en a besoin pour DIRE l'absence — voir
 * `dossiersNonConstates` juste en dessous, et le refus de
 * `declare_verification`.
 */
export function observedDeliverableKeys(input: {
  readonly changedFiles: readonly MutationTarget[];
  readonly dirTargets: readonly MutationTarget[];
  readonly workspaceRoots: readonly string[];
  /**
   * Le MÊME prédicat que l'intention (`projects/declared.ts`) : manifeste sur
   * le disque OU projet déclaré. Sans lui, les clés des deux côtés divergent
   * dès qu'un projet déclaré n'a pas de manifeste, et une écriture bel et bien
   * constatée sur le disque laisse `produced` faux — mesuré, revue Codex
   * post-merge de la PR #66, constat C4.
   *
   * OBLIGATOIRE (revue de la PR #103, Reviewer C, passe 2). Il portait un repli
   * sur `hasMarker` seul : un appelant qui l'oubliait retrouvait EN SILENCE la
   * règle d'avant ce correctif, et le désaccord ne se voyait nulle part — un
   * repli intelligent, exactement ce que l'invariant #4 refuse. L'oubli est
   * désormais une erreur du compilateur, pas un `produced` faux en production.
   */
  readonly isProjectRoot: (dir: string) => boolean;
}): ReadonlySet<string> {
  const keys = new Set<string>();
  const rebasedFiles = rebaseOntoLexicalRoots(input.changedFiles, input.workspaceRoots);
  const isProjectRoot = input.isProjectRoot;
  const projects = (targets: readonly MutationTarget[]): readonly ProjectRoot[] =>
    resolveProjectRoots({
      targets,
      workspaceRoots: input.workspaceRoots,
      hasMarker: isProjectRoot,
    });
  for (const p of projects(rebasedFiles.filter((t) => t.deliverableType === 'code_project'))) {
    keys.add(p.key);
  }
  // Les cibles DOSSIER ne créditent rien (#102). La ligne d'avant faisait
  // `for (const p of projects(rebasedDirs)) keys.add(p.key)` : le projet du
  // `cwd` était crédité sur la foi de la cible, sans qu'un octet ait été lu.
  for (const f of officeFileDeliverables(
    rebasedFiles.filter((t) => t.deliverableType !== 'code_project'),
    input.workspaceRoots,
  )) {
    keys.add(f.key);
  }
  return keys;
}

/**
 * Les projets qu'une cible DOSSIER aurait crédités, et que plus rien ne
 * crédite — ce dont il n'a RIEN été constaté.
 *
 * Existe pour que l'absence se dise (invariant #4). L'appelant en fait une
 * ligne de journal à code ; `declare_verification`, plus tard et depuis la
 * base, en fait un refus qui nomme le fait. Les clés déjà soutenues par une
 * écriture constatée en sont retirées : une commande qui a aussi écrit un
 * fichier nommé dans le même projet n'a rien d'inconstaté.
 */
export function dossiersNonConstates(input: {
  readonly changedFiles: readonly MutationTarget[];
  readonly dirTargets: readonly MutationTarget[];
  readonly workspaceRoots: readonly string[];
  readonly isProjectRoot: (dir: string) => boolean;
}): ReadonlySet<string> {
  const constatees = observedDeliverableKeys(input);
  const rebasedDirs = rebaseOntoLexicalRoots(input.dirTargets, input.workspaceRoots);
  const out = new Set<string>();
  for (const p of resolveProjectRoots({
    targets: rebasedDirs,
    workspaceRoots: input.workspaceRoots,
    hasMarker: input.isProjectRoot,
  })) {
    if (!constatees.has(p.key)) out.add(p.key);
  }
  return out;
}
