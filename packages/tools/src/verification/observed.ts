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
// on le reprend après, et une différence est une écriture constatée. Une cible
// DOSSIER (le `cwd` d'un shell) reste déclarative : constater ce qu'un shell
// a écrit sous un dossier demanderait un instantané de l'arbre à chaque
// commande, et c'est un autre lot — dit ici, pas caché.
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
import { hasMarker, rebaseOntoLexicalRoots } from '../projects/markers';
import { officeFileDeliverables } from './office-file-key';

/** L'empreinte d'un fichier à un instant : `null` = absent. */
export type FileFingerprint = { readonly size: bigint; readonly sha256: string } | null;

export type FileSnapshot = ReadonlyMap<string, FileFingerprint>;

async function fingerprint(path: string): Promise<FileFingerprint> {
  try {
    const s = await stat(path, { bigint: true });
    if (!s.isFile()) return null;
    const bytes = await readFile(path);
    return { size: s.size, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return null;
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

/** Les cibles FICHIER dont l'empreinte a changé depuis l'instantané. */
export async function changedFileTargets(
  targets: readonly MutationTarget[],
  before: FileSnapshot,
): Promise<MutationTarget[]> {
  const out: MutationTarget[] = [];
  for (const t of targets) {
    if (t.kind !== 'file') continue;
    const was = before.get(t.path) ?? null;
    const now = await fingerprint(t.path);
    const same =
      (was === null && now === null) ||
      (was !== null && now !== null && was.size === now.size && was.sha256 === now.sha256);
    if (!same) out.push(t);
  }
  return out;
}

/**
 * Les clés de livrables qu'une écriture CONSTATÉE (ou une cible dossier,
 * déclarative) soutient — la même règle de nommage que l'intention, sans
 * expansion : ce sont les livrables VISÉS qui comptent ici, jamais le périmètre
 * de précaution.
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
   * post-merge de la PR #66, constat C4. Omis = `hasMarker` seul.
   */
  readonly isProjectRoot?: (dir: string) => boolean;
}): ReadonlySet<string> {
  const keys = new Set<string>();
  const rebasedFiles = rebaseOntoLexicalRoots(input.changedFiles, input.workspaceRoots);
  const rebasedDirs = rebaseOntoLexicalRoots(input.dirTargets, input.workspaceRoots);
  const isProjectRoot = input.isProjectRoot ?? hasMarker;
  const projects = (targets: readonly MutationTarget[]): readonly ProjectRoot[] =>
    resolveProjectRoots({
      targets,
      workspaceRoots: input.workspaceRoots,
      hasMarker: isProjectRoot,
    });
  for (const p of projects(rebasedFiles.filter((t) => t.deliverableType === 'code_project'))) {
    keys.add(p.key);
  }
  for (const p of projects(rebasedDirs)) keys.add(p.key);
  for (const f of officeFileDeliverables(
    rebasedFiles.filter((t) => t.deliverableType !== 'code_project'),
    input.workspaceRoots,
  )) {
    keys.add(f.key);
  }
  return keys;
}
