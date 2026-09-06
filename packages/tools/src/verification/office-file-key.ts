// office-file-key.ts — l'identité d'un DOCUMENT, calculée à un seul endroit.
//
// Deux lecteurs ont besoin de la même clé pour le même fichier : l'intention
// de mutation, qui range l'état de vérification du document sous cette clé
// dans `job_deliverable_verification_state`, et la carte `files` de l'outil
// qui vient d'écrire le classeur, qui porte la clé pour que l'écran retrouve
// cet état (P12). Tant que chacun la calculait de son côté, elles pouvaient
// diverger — et elles divergeaient : l'intention rebase le chemin réel sur la
// racine LEXICALE de l'espace de travail (une racine attachée par jonction ou
// lien symbolique garde son nom), la carte prenait le chemin réel tel quel.
// Sous une jonction, la carte cherchait une clé que personne n'avait écrite
// et le pied de vérification n'apparaissait jamais (revue Codex PR #46,
// passe 46).
//
// Une fonction, deux appelants : la clé ne peut plus diverger que si l'un
// des deux cesse de l'appeler.

import type { MutationTarget, ProjectRoot } from '@nodal-agents/shared';
import { resolveFileDeliverables } from '@nodal-agents/shared';
import { rebaseOntoLexicalRoots } from '../projects/markers';

/**
 * Les documents que désignent ces cibles, chacun sous sa clé canonique :
 * chemin rebasé sur la racine lexicale la plus spécifique, puis `projectKey`.
 * Une cible qui n'est sous aucune racine ne rend rien — c'est à l'appelant
 * de le dire, pas de lui inventer une clé.
 */
export function officeFileDeliverables(
  targets: readonly MutationTarget[],
  workspaceRoots: readonly string[],
): readonly ProjectRoot[] {
  return resolveFileDeliverables({
    targets: rebaseOntoLexicalRoots(targets, workspaceRoots),
    workspaceRoots,
  });
}

/**
 * La clé d'UN document écrit à `absPath` (chemin absolu résolu par l'outil,
 * donc réel), ou `null` si aucune racine de l'agent ne le contient — ce qui ne
 * devrait pas arriver après `resolveAndCheckPath`, et qui, si cela arrive,
 * vaut une carte sans état plutôt qu'une clé fausse.
 */
export function officeFileDeliverableKey(
  absPath: string,
  workspaceRoots: readonly string[],
): string | null {
  const [file] = officeFileDeliverables(
    [{ kind: 'file', path: absPath, deliverableType: 'office_file' }],
    workspaceRoots,
  );
  return file?.key ?? null;
}
