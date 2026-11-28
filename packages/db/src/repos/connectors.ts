// repos/connectors.ts — un connecteur à clé d'API, et qui parmi les agents le tient.
//
// Les écritures de `saveApiKeyConnectorAction` et de
// `setAgentConnectorAssignmentAction` (apps/web/src/lib/actions.ts), sorties
// pour que le banc v2 donne à ses agents leurs connecteurs par le même chemin
// que l'écran (règle 11). Le contrôle du catalogue (le slug existe, il se
// connecte par clé d'API) reste chez l'appelant : c'est lui qui sait quel
// catalogue il présente.

import { and, asc, eq } from 'drizzle-orm';
import { encrypt, isEncrypted } from '@nodal-agents/secrets';
import {
  indistinctAccountsMessage,
  sameAccountName,
  type NamedConnector,
} from '@nodal-agents/shared';
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
 * Le connecteur de l'agent dont `candidate` ne se distinguerait pas : un autre
 * compte du même service, sous le même nom (`sameAccountName`). Dans un job,
 * les outils de plusieurs comptes d'un service portent un argument `account`
 * dont les valeurs sont leurs noms ; deux noms qu'un modèle ne sait pas
 * départager ne désigneraient pas un compte. Chaque chemin qui donne un
 * connecteur à un agent, ou qui le renomme, refuse donc ce cas, et dit lequel.
 */
export async function findIndistinctAccountOnAgent(
  db: AnyDrizzleDb,
  agentId: string,
  candidate: NamedConnector,
): Promise<NamedConnector | null> {
  const held = await db
    .select({ id: connectors.id, slug: connectors.slug, name: connectors.name })
    .from(agentConnectorAssignments)
    .innerJoin(connectors, eq(connectors.id, agentConnectorAssignments.connectorId))
    .where(eq(agentConnectorAssignments.agentId, agentId))
    .orderBy(asc(connectors.name), asc(connectors.id));
  return held.find((h) => sameAccountName(candidate, h)) ?? null;
}

/**
 * Le refus d'un renommage : `connectorId` renommé `name` ne se distinguerait
 * plus d'un autre compte du même service sur l'un des agents qui le tiennent.
 * Le message nomme les deux connecteurs ; null quand le nom est libre.
 */
export async function connectorRenameRefusal(
  db: AnyDrizzleDb,
  connectorId: string,
  name: string,
): Promise<string | null> {
  const [connector] = await db
    .select({ id: connectors.id, slug: connectors.slug })
    .from(connectors)
    .where(eq(connectors.id, connectorId));
  if (!connector) return null;
  const renamed = { ...connector, name };
  const holders = await db
    .select({ agentId: agentConnectorAssignments.agentId })
    .from(agentConnectorAssignments)
    .where(eq(agentConnectorAssignments.connectorId, connectorId))
    .orderBy(asc(agentConnectorAssignments.agentId));
  for (const { agentId } of holders) {
    const clash = await findIndistinctAccountOnAgent(db, agentId, renamed);
    if (clash) return indistinctAccountsMessage(renamed, clash);
  }
  return null;
}

/**
 * Donne (ou retire) un connecteur à un agent. L'agent ET le connecteur doivent
 * appartenir à l'espace. Retirer est idempotent ; donner est un upsert sur
 * (agent_id, connector_id), qui remplace la liste des opérations permises.
 * Donner est refusé quand l'agent tient déjà un autre compte du même service
 * sous le même nom (`indistinct_accounts`, le message nomme les deux).
 */
export async function setAgentConnectorAssignmentRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: SetAgentConnectorAssignmentInput,
): Promise<
  | { ok: true }
  | { error: 'agent_not_found' | 'connector_not_found' }
  | { error: 'indistinct_accounts'; message: string }
> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.entityId, entityId)));
  if (!agent) return { error: 'agent_not_found' };

  const [connector] = await db
    .select({ id: connectors.id, slug: connectors.slug, name: connectors.name })
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
  const clash = await findIndistinctAccountOnAgent(db, input.agentId, connector);
  if (clash) {
    return { error: 'indistinct_accounts', message: indistinctAccountsMessage(connector, clash) };
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
