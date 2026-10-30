// queries/workspace-scope.ts — L'ESPACE d'un travail, dérivé en UN endroit.
//
// Le sien, sinon celui de son agent (`agents.entity_id` — un agent appartient
// toujours à un espace : `createAgentRepo`, seul écrivain, l'exige). Un job
// sans espace propre existe (un appelant interne de /api/agent le crée avec
// `entity_id` NULL) : ce qu'il fait relève alors de l'espace de son agent.
//
// Deux lecteurs : les handles de conversation (`conversationIdsAsHandles`) et
// le réglage du bac à sable (`workspaceSandboxReader`, #876). Chacun dit avec
// SON code ce qu'il fait d'un travail qui n'a d'espace ni par lui ni par son
// agent ; cette fonction rend `null`, elle ne choisit pas.

import { eq } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/index.ts';

/** Ce qu'on sait d'un travail pour lui trouver un espace. */
export interface WorkspaceScope {
  /** Son espace, quand il en a un. Vide ou `null` : on demande à son agent. */
  entityId: string | null;
  agentId?: string | null;
}

/** L'espace du travail, ou `null` quand ni lui ni son agent n'en ont. */
export async function workspaceOfScope(
  db: AnyDrizzleDb,
  scope: WorkspaceScope,
): Promise<string | null> {
  if (scope.entityId) return scope.entityId;
  if (scope.agentId) {
    const [agent] = await db
      .select({ entityId: agents.entityId })
      .from(agents)
      .where(eq(agents.id, scope.agentId))
      .limit(1);
    if (agent?.entityId) return agent.entityId;
  }
  return null;
}
