// packages/db/src/repos/agents.ts
// Pure DB repository functions for agent creation.
// Takes a db instance + entityId + already-validated input; returns a
// discriminated result or throws on unexpected errors.

import { eq, and, inArray } from 'drizzle-orm';
import { INITIAL_AUTO_ROOT_GRANTS } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agents, agentAssignments } from '../schema/agents.ts';
import { entities } from '../schema/entities.ts';

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
  /**
   * If set, assign the newly-created agent as a sub-agent of this orchestrator
   * — i.e. the ROOT that created it. Idempotent: skipped if the row already
   * exists (e.g. Brique F already wired a new orchestrator under the same ROOT).
   */
  assignToOrchestratorId?: string;
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
    // Check both err.message and err.cause.message: drizzle-orm's pglite adapter
    // wraps the Postgres error in a "Failed query: ..." outer error and places
    // the actual constraint violation in err.cause.message.
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    if (
      msg.includes('unique') ||
      msg.includes('23505') ||
      causeMsg.includes('unique') ||
      causeMsg.includes('23505')
    ) {
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

  // ─── ROOT = origin orchestrator (Brique F) ──────────────────────────────────
  // Structural invariant: exactly ONE top-level orchestrator per entity = the
  // ROOT. The first orchestrator created in an entity is auto-designated ROOT;
  // every subsequent orchestrator is forced under it as a sub-agent, so there is
  // never a second top-level orchestrator. Workers are untouched.
  if (input.role === 'orchestrator') {
    const [ent] = await db
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);

    if (!ent?.rootAgentId) {
      // First orchestrator → auto-ROOT. Grants start all-OFF (opt-in powers):
      // the agent is structurally ROOT but holds no meta-tools until the user
      // enables them in Settings. Writing explicit grants is REQUIRED — a null
      // rootGrants parses to all-on and would expose un-gated meta-tools.
      await db
        .update(entities)
        .set({
          rootAgentId: row.id,
          rootGrants:
            INITIAL_AUTO_ROOT_GRANTS as unknown as (typeof entities.$inferInsert)['rootGrants'],
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entityId));
    } else if (ent.rootAgentId !== row.id) {
      // Subsequent orchestrator → forced as a sub-agent of the ROOT.
      await db.insert(agentAssignments).values({
        orchestratorId: ent.rootAgentId,
        subAgentId: row.id,
        entityId,
      });
    }
  }

  // ─── Auto-assign under caller (ROOT creates sub-agent) ──────────────────────
  // When a ROOT uses the create_agent meta-tool, it passes its own id as
  // assignToOrchestratorId so the new agent is immediately visible in its team
  // block and can receive delegations. The insert is guarded by a SELECT first
  // because: (a) the table has no unique constraint in production, so a duplicate
  // row would silently create a second link; (b) Brique F above may have already
  // inserted the row when a new orchestrator is created under the same ROOT.
  if (input.assignToOrchestratorId && input.assignToOrchestratorId !== row.id) {
    const existing = await db
      .select({ id: agentAssignments.id })
      .from(agentAssignments)
      .where(
        and(
          eq(agentAssignments.orchestratorId, input.assignToOrchestratorId),
          eq(agentAssignments.subAgentId, row.id),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(agentAssignments).values({
        orchestratorId: input.assignToOrchestratorId,
        subAgentId: row.id,
        entityId,
      });
    }
  }

  return { id: row.id };
}
