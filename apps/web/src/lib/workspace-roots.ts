// workspace-roots.ts — les racines des dossiers de travail d'une entité.
//
// Une requête, partagée par la page Code (liste et détail) et par le fil de
// conversation (récapitulatif de livraison), pour que tous canonicalisent les
// chemins des fichiers changés de la même façon (`canonicalChangePath`). Sortie
// d'`actions.ts` en P2bis : ce fichier est `'use server'`, et un helper non
// exporté ne peut pas servir deux modules.
//
// Les racines sont de deux sortes : celles que chaque agent déclare
// (`agent_workspaces`), et le dossier PARTAGÉ de l'entité, que le runner
// injecte à chaque job sans le ranger en base (`workspace-list.ts`). Sans le
// second, le chemin résolu que `file_write` présente
// (`…/workspaces/<entité>/shared/notes/x.html`) ne se ramenait jamais au
// relatif, et le même fichier comptait deux fois (vu en vrai, passe 57).
//
// Ce que ça change, et ne change pas : le récapitulatif du fil canonicalise
// tout ce qu'il compte avec ces racines. La page Code, elle, ne retient qu'un
// changement situé dans un dossier DÉCLARÉ (`isInsideWorkspace`, avant toute
// canonicalisation) : un fichier du dossier partagé n'y entre pas davantage
// qu'avant (revue Codex, passe 58). Contrainte de déploiement : le web et le
// runner doivent lire le même `NODALAI_WORKSPACES_ROOT` (ou le même dossier
// personnel), sinon la racine ne se retire pas et un fichier peut compter
// deux fois — rien ne le vérifie ici.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentWorkspaces, agents, and, codeProjects, eq, isNotNull } from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import type { getDb } from './server.ts';

/**
 * Le dossier partagé de l'entité — le MÊME calcul que le runner
 * (`apps/runner/src/lib/workspaces-root.ts`) :
 * `<NODALAI_WORKSPACES_ROOT | ~/.nodalai/workspaces>/<entityId>/shared`.
 */
export function sharedWorkspacePath(entityId: string): string {
  return join(
    process.env['NODALAI_WORKSPACES_ROOT'] ?? join(homedir(), '.nodalai', 'workspaces'),
    entityId,
    'shared',
  );
}

/** Ce que `entityWorkspaceRoots` lit de la base : de quoi enchaîner la requête. */
export type WorkspaceRootsDb = Pick<ReturnType<typeof getDb>, 'select'>;

/** Toutes les racines de l'entité (agents + dossier partagé), les plus
 *  longues d'abord — un dossier imbriqué se retire avant son parent. */
export async function entityWorkspaceRoots(
  db: WorkspaceRootsDb,
  entityId: string,
): Promise<string[]> {
  const rows = await db
    .select({ path: agentWorkspaces.path })
    .from(agentWorkspaces)
    .innerJoin(agents, eq(agents.id, agentWorkspaces.agentId))
    .where(eq(agents.entityId, entityId));
  const roots = new Set<string>(rows.map((r) => r.path));
  roots.add(sharedWorkspacePath(entityId));
  return [...roots].sort((a, b) => b.length - a.length);
}

/**
 * Les clés des projets de code DÉCLARÉS de l'entité.
 *
 * Une déclaration vaut manifeste : c'est la règle de
 * `packages/tools/src/projects/declared.ts`, et l'écran Code doit la lire comme
 * l'intention, l'observation, le registre et le contexte des agents la lisent.
 * Sans elle, un dossier attaché déclaré projet sans manifeste s'affichait
 * éclaté en ses enfants d'un côté et entier de l'autre (revue Codex de la dette
 * de la PR #75, passe 2, constat 1).
 */
export async function entityDeclaredCodeRoots(
  db: WorkspaceRootsDb,
  entityId: string,
): Promise<ReadonlySet<string>> {
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
  return new Set(rows.map((r) => projectKey(r.path)));
}
