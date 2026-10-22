// repos/connectors.ts — un connecteur à clé d'API, et qui parmi les agents le tient.
//
// Les écritures de `saveApiKeyConnectorAction` et de
// `setAgentConnectorAssignmentAction` (apps/web/src/lib/actions.ts), sorties
// pour que le banc v2 donne à ses agents leurs connecteurs par le même chemin
// que l'écran (règle 11). Le contrôle du catalogue (le slug existe, il se
// connecte par clé d'API) reste chez l'appelant : c'est lui qui sait quel
// catalogue il présente.

import { and, eq } from 'drizzle-orm';
import { encrypt, isEncrypted } from '@nodal-agents/secrets';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/agents.ts';
import { agentConnectorAssignments } from '../schema/agent-connector-assignments.ts';
import { connectors } from '../schema/connectors.ts';

export interface CreateApiKeyConnectorInput {
  readonly slug: string;
  readonly name: string;
  /** En clair, ou déjà chiffré (`enc:v1:`) : chiffré une seule fois. */
  readonly apiKey: string;
}

/**
 * Une INSERTION pure : chaque appel crée une instance de plus pour le couple
 * (espace, slug). Pour changer la clé ou le nom d'une instance existante :
 * la renommer, ou la supprimer et la recréer.
 */
export async function createApiKeyConnectorRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: CreateApiKeyConnectorInput,
): Promise<{ id: string }> {
  const apiKey = isEncrypted(input.apiKey) ? input.apiKey : encrypt(input.apiKey);
  const [row] = await db
    .insert(connectors)
    .values({
      entityId,
      slug: input.slug,
      name: input.name,
      apiKey,
      authType: 'api_key',
      active: true,
    })
    .returning({ id: connectors.id });
  if (!row) throw new Error('connector_insert_no_row: the insert returned no row');
  return { id: row.id };
}

export interface SetAgentConnectorAssignmentInput {
  readonly agentId: string;
  readonly connectorId: string;
  readonly assigned: boolean;
  /** Les opérations permises ; null = toutes celles du connecteur. */
  readonly enabledOperations: string[] | null;
}

/**
 * Donne (ou retire) un connecteur à un agent. L'agent ET le connecteur doivent
 * appartenir à l'espace. Retirer est idempotent ; donner est un upsert sur
 * (agent_id, connector_id), qui remplace la liste des opérations permises.
 */
export async function setAgentConnectorAssignmentRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: SetAgentConnectorAssignmentInput,
): Promise<{ ok: true } | { error: 'agent_not_found' | 'connector_not_found' }> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.entityId, entityId)));
  if (!agent) return { error: 'agent_not_found' };

  const [connector] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.id, input.connectorId), eq(connectors.entityId, entityId)));
  if (!connector) return { error: 'connector_not_found' };

  if (!input.assigned) {
    await db
      .delete(agentConnectorAssignments)
      .where(
        and(
          eq(agentConnectorAssignments.agentId, input.agentId),
          eq(agentConnectorAssignments.connectorId, input.connectorId),
        ),
      );
    return { ok: true };
  }
  await db
    .insert(agentConnectorAssignments)
    .values({
      agentId: input.agentId,
      connectorId: input.connectorId,
      entityId,
      enabledOperations: input.enabledOperations,
    })
    .onConflictDoUpdate({
      target: [agentConnectorAssignments.agentId, agentConnectorAssignments.connectorId],
      set: { enabledOperations: input.enabledOperations, updatedAt: new Date() },
    });
  return { ok: true };
}
