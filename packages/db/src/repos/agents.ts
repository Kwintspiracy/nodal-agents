// packages/db/src/repos/agents.ts
// Pure DB repository functions for agent creation.
// Takes a db instance + entityId + already-validated input; returns a
// discriminated result or throws on unexpected errors.

import { eq, and, inArray } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { agents, agentAssignments } from '../schema/agents.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateAgentInput {
  slug: string;
  name: string;
  personality: string;
  model: string;
  llmKeyId: string | null | undefined;
  /** DB-level role: 'agent' | 'orchestrator' (already translated from UX-level worker/router/planner) */
  role: 'agent' | 'orchestrator';
  /** DB-level orchestrator mode (null for workers) */
  orchestratorMode: 'router' | 'planner' | null;
  avatarUrl: string | null | undefined;
  subAgentIds: string[];
}

export type CreateAgentResult = { id: string } | { error: 'slug_taken' };

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Insert a new agent (and optional sub-agent assignments) within an entity.
 *
 * Validates that all sub-agents exist in the same entity before inserting.
 * Returns `{ error: 'slug_taken' }` when the slug unique constraint fires
 * (Postgres error code 23505 / message contains 'unique').
 * Returns `{ error: 'slug_taken' }` when subAgentIds contains IDs not found
 * in the entity (piggybacked on slug_taken for now; callers should distinguish
 * by checking input). Actually returns a distinct path — see below.
 *
 * NOTE: sub-agent validation failure throws `Error('sub_agents_not_found')`
 * so the action layer can surface it as validation_failed.
 */
export async function createAgentRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  // Verify all sub-agents exist in the same entity before the insert.
  if (input.subAgentIds.length > 0) {
    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, input.subAgentIds), eq(agents.entityId, entityId)));
    if (found.length !== input.subAgentIds.length) {
      throw new Error('sub_agents_not_found');
    }
  }

  let row: { id: string } | undefined;
  try {
    const [inserted] = await db
      .insert(agents)
      .values({
        entityId,
        slug: input.slug,
        name: input.name,
        personality: input.personality,
        model: input.model,
        llmKeyId: input.llmKeyId ?? null,
        role: input.role,
        orchestratorMode: input.orchestratorMode,
        avatarUrl: input.avatarUrl ?? null,
      })
      .returning({ id: agents.id });
    row = inserted;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique') || msg.includes('23505')) {
      return { error: 'slug_taken' };
    }
    throw err;
  }

  if (!row) throw new Error('Insert returned no row');

  if (input.subAgentIds.length > 0) {
    await db.insert(agentAssignments).values(
      input.subAgentIds.map((subId) => ({
        orchestratorId: row!.id,
        subAgentId: subId,
        entityId,
      })),
    );
  }

  return { id: row.id };
}
