// repos/agent-workspaces.ts — rattacher un dossier de travail à un agent.
//
// L'écriture de `addAgentWorkspaceAction` (apps/web/src/lib/actions.ts),
// sortie pour que le banc v2 rattache les dossiers de son équipe par le même
// chemin que l'écran (règle 11). Le contrôle de forme du libellé et du chemin
// reste chez l'appelant ; l'appartenance de l'agent à l'espace est vérifiée ici.

import { and, eq } from 'drizzle-orm';
import { projectKey } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/agents.ts';
import { agentWorkspaces } from '../schema/agent-workspaces.ts';

export interface AddAgentWorkspaceInput {
  readonly agentId: string;
  readonly label: string;
  /** Absolu, déjà nettoyé par l'appelant. */
  readonly path: string;
}

export async function addAgentWorkspaceRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: AddAgentWorkspaceInput,
): Promise<{ id: string } | { error: 'agent_not_found' }> {
  const [agentRow] = await db
    .select({ id: agents.id, entityId: agents.entityId })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.entityId, entityId)));
  if (!agentRow) return { error: 'agent_not_found' };

  // Un chemin DÉJÀ masqué ailleurs dans l'espace arrive masqué ici (0087).
  // Sans cet héritage, attacher le coffre à un second agent le ferait
  // réapparaître dans l'onglet Code, avec une case vide sur cette fiche
  // pendant qu'une autre ligne dit l'inverse. Un dossier est un coffre de
  // notes ou non ; cela ne dépend pas de l'agent qui le regarde.
  //
  // Comparaison NORMALISÉE, pas textuelle : `C:\Vault` et `c:/vault` sont le
  // même dossier.
  const dejaMasque = (
    await db
      .select({ path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.entityId, entityId), eq(agentWorkspaces.hiddenFromCode, true)))
  ).some((r) => projectKey(r.path) === projectKey(input.path));

  const [row] = await db
    .insert(agentWorkspaces)
    .values({
      agentId: input.agentId,
      entityId: agentRow.entityId,
      label: input.label,
      path: input.path,
      position: 0,
      hiddenFromCode: dejaMasque,
    })
    .returning({ id: agentWorkspaces.id });
  if (!row) throw new Error('agent_workspace_insert_no_row: the insert returned no row');
  return { id: row.id };
}
