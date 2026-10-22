// repos/workspaces.ts — créer un espace et régler ses interrupteurs.
//
// Ces écritures vivaient en ligne dans les actions du tableau de bord
// (apps/web/src/lib/actions.ts, learned-skills-actions.ts). Le banc v2 monte
// une instance de Nodal et y applique sa configuration (packages/bench/src/
// campaign) : il passe par CES fonctions, les mêmes que l'écran, pour qu'un
// changement de l'une atteigne l'autre (règle 11). Les gardes d'accès (session,
// propriétaire de l'espace) restent dans l'action : elles dépendent de qui
// appelle, pas de ce qui est écrit.

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { entities, entityMembers } from '../schema/entities.ts';

/** Le slug d'un nouvel espace : son nom en minuscules, puis six caractères tirés. */
export function workspaceSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

export interface CreateWorkspaceInput {
  readonly userId: string;
  readonly name: string;
  readonly icon?: string;
}

/** Crée l'espace ET la ligne d'appartenance de son propriétaire. */
export async function createWorkspaceRepo(
  db: AnyDrizzleDb,
  input: CreateWorkspaceInput,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await db.insert(entities).values({
    id,
    userId: input.userId,
    name: input.name,
    slug: workspaceSlug(input.name),
    icon: input.icon ?? '🗂️',
  });
  await db.insert(entityMembers).values({ entityId: id, userId: input.userId, role: 'owner' });
  return { id };
}

/** Le plafond d'un run de l'espace : coût en dollars, durée en heures (0 = sans plafond). */
export async function setRunBudgetRepo(
  db: AnyDrizzleDb,
  entityId: string,
  budget: { maxRunCostUsd: number; maxRunHours: number },
): Promise<void> {
  await db
    .update(entities)
    .set({ maxRunCostUsd: budget.maxRunCostUsd, maxRunHours: budget.maxRunHours })
    .where(eq(entities.id, entityId));
}

/** Le serveur MCP de Nodal pour cet espace (`run_task` d'un client MCP). */
export async function setMcpServerEnabledRepo(
  db: AnyDrizzleDb,
  entityId: string,
  enabled: boolean,
): Promise<void> {
  await db.update(entities).set({ mcpServerEnabled: enabled }).where(eq(entities.id, entityId));
}

/** La réflexion après tâche de l'espace (apprentissage de skills). */
export async function setReflectionEnabledRepo(
  db: AnyDrizzleDb,
  entityId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(entities)
    .set({ reflectionEnabled: enabled, updatedAt: new Date() })
    .where(eq(entities.id, entityId));
}
