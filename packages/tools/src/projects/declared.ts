// projects/declared.ts — les projets de code DÉCLARÉS, et le prédicat
// « cette racine est-elle un projet ? » qui en tient compte.
//
// POURQUOI CE MODULE. La PR #66 a fait d'un projet déclaré (`code_projects`,
// `registered_at` non nul, `kind = 'code'`) un critère de TYPAGE : un fichier
// écrit sous lui est du `code_project`, même sans manifeste sur le disque.
// Mais la CLÉ du livrable, elle, continuait d'être calculée par
// `resolveProjectRoots` avec le seul `hasMarker` — la déclaration n'entrait
// pas dans le calcul de l'identité.
//
// Le désaccord est mesurable (revue Codex post-merge de la PR #66, constat
// C4). Deux dossiers attachés qui s'emboîtent, `/w` et `/w/app`, `/w/app`
// déclaré projet de code et sans manifeste ; écriture de `/w/app/src/x.ts` :
//
//   type = code_project  (la déclaration décide)
//   clé  = /w/app/src    (un sous-dossier qui n'est le projet de personne)
//
// L'intention salit alors une clé dont aucune configuration de vérification
// n'existe, et la preuve du projet déclaré ne couvre pas ce qui vient d'être
// écrit. Le prédicat ci-dessous met les deux faits au même niveau : une racine
// est un projet si elle porte un manifeste OU si elle est déclarée. Les trois
// endroits qui calculent une clé de projet le partagent, pour qu'aucun d'eux
// ne voie un projet là où un autre n'en voit pas.

import { and, eq, isNotNull, codeProjects } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import { hasMarker } from './markers';

/** Les chemins des projets DÉCLARÉS de `kind = 'code'` pour cette entité. */
export async function loadDeclaredCodeRoots(db: AnyDrizzleDb, entityId: string): Promise<string[]> {
  if (!entityId) return [];
  const rows = await db
    .select({ path: codeProjects.projectPath })
    .from(codeProjects)
    .where(
      and(
        eq(codeProjects.entityId, entityId),
        isNotNull(codeProjects.registeredAt),
        eq(codeProjects.kind, 'code'),
      ),
    );
  return rows.map((r) => r.path);
}

/**
 * « Cette racine EST un projet de code » — le manifeste sur le disque, ou la
 * déclaration en base. Injecté dans `resolveProjectRoots`, qui est pur et ne
 * lit ni l'un ni l'autre.
 *
 * Sans racine déclarée, le prédicat est exactement `hasMarker` : le
 * comportement d'avant ce correctif, mot pour mot.
 */
export function projectRootPredicate(
  declaredCodeRoots: readonly string[],
): (dir: string) => boolean {
  if (declaredCodeRoots.length === 0) return hasMarker;
  const declared = new Set(declaredCodeRoots.map((p) => projectKey(p)));
  return (dir: string): boolean => hasMarker(dir) || declared.has(projectKey(dir));
}
