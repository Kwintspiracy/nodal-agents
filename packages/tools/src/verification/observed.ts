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
// l'état du fichier avant l'outil (existence, taille, mtime en nanosecondes),
// on le reprend après, et une différence est une écriture constatée. Une cible
// DOSSIER (le `cwd` d'un shell) reste déclarative : constater ce qu'un shell
// a écrit sous un dossier demanderait un instantané de l'arbre à chaque
// commande, et c'est un autre lot — dit ici, pas caché.
//
// Ce qui n'est PAS constaté : un contenu réécrit à l'identique dans la même
// nanoseconde. Le système de fichiers ne le distingue pas non plus.

import { stat } from 'node:fs/promises';
import type { MutationTarget, ProjectRoot } from '@nodal-agents/shared';
import { resolveProjectRoots } from '@nodal-agents/shared';
import { hasMarker, rebaseOntoLexicalRoots } from '../projects/markers';
import { officeFileDeliverables } from './office-file-key';

/** L'empreinte d'un fichier à un instant : `null` = absent. */
export type FileFingerprint = { readonly size: bigint; readonly mtimeNs: bigint } | null;

export type FileSnapshot = ReadonlyMap<string, FileFingerprint>;

async function fingerprint(path: string): Promise<FileFingerprint> {
  try {
    const s = await stat(path, { bigint: true });
    return s.isFile() ? { size: s.size, mtimeNs: s.mtimeNs } : null;
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
      (was !== null && now !== null && was.size === now.size && was.mtimeNs === now.mtimeNs);
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
}): ReadonlySet<string> {
  const keys = new Set<string>();
  const rebasedFiles = rebaseOntoLexicalRoots(input.changedFiles, input.workspaceRoots);
  const rebasedDirs = rebaseOntoLexicalRoots(input.dirTargets, input.workspaceRoots);
  const projects = (targets: readonly MutationTarget[]): readonly ProjectRoot[] =>
    resolveProjectRoots({ targets, workspaceRoots: input.workspaceRoots, hasMarker });
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
