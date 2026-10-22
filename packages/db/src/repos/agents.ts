// packages/db/src/repos/agents.ts
// Pure DB repository functions for agent creation, and the agent's model.
// Takes a db instance + entityId + already-validated input; returns a
// discriminated result or throws on unexpected errors.

import { eq, and, or, ilike, inArray, isNull } from 'drizzle-orm';
import { INITIAL_AUTO_ROOT_GRANTS, findModelCatalogEntry } from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agents, agentAssignments } from '../schema/agents.ts';
import { entities } from '../schema/entities.ts';
import { entityLlmKeys } from '../schema/llm_keys.ts';

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
   * The delegation text the orchestrator is shown for each sub-agent
   * (`agent_assignments.instructions`, rendered in its team block), keyed by
   * sub-agent id. Optional: the create form sets none, the edit form writes
   * them later; a caller that knows them up front (the bench applying its
   * configuration) writes them in the same insert.
   */
  subAgentInstructions?: Readonly<Record<string, string>>;
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
  // An instruction for an agent that is not a sub-agent would be dropped in
  // silence: refused instead (invariant #4).
  const stray = Object.keys(input.subAgentInstructions ?? {}).filter(
    (id) => !input.subAgentIds.includes(id),
  );
  if (stray.length > 0)
    throw new Error(`sub_agent_instructions_without_sub_agent: ${stray.join(', ')}`);

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
        instructions: input.subAgentInstructions?.[subId] ?? null,
      })),
    );
  }

  // ─── ROOT = origin orchestrator (Brique F) ──────────────────────────────────
  // Structural invariant: exactly ONE top-level orchestrator per entity = the
  // ROOT. The first orchestrator created in an entity is auto-designated ROOT;
  // every subsequent orchestrator is forced under it as a sub-agent, so there is
  // never a second top-level orchestrator. Workers are untouched.
  if (input.role === 'orchestrator') {
    // The claim is ATOMIC: one conditional UPDATE, not a SELECT followed by an
    // unconditional UPDATE. Two orchestrators created at the same time both
    // read "no ROOT yet", and the last UPDATE won — leaving two top-level
    // orchestrators, the very thing the invariant forbids (Codex review, pass
    // 63). `WHERE root_agent_id IS NULL … RETURNING` lets exactly one win.
    //
    // First orchestrator → auto-ROOT. Grants start all-OFF (opt-in powers):
    // the agent is structurally ROOT but holds no meta-tools until the user
    // enables them in Settings. Writing explicit grants is REQUIRED — a null
    // rootGrants parses to all-on and would expose un-gated meta-tools.
    const claimed = await db
      .update(entities)
      .set({
        rootAgentId: row.id,
        rootGrants:
          INITIAL_AUTO_ROOT_GRANTS as unknown as (typeof entities.$inferInsert)['rootGrants'],
        updatedAt: new Date(),
      })
      .where(and(eq(entities.id, entityId), isNull(entities.rootAgentId)))
      .returning({ rootAgentId: entities.rootAgentId });

    if (claimed.length === 0) {
      // Someone is ROOT already (or just won the race) → this orchestrator is
      // forced under it as a sub-agent.
      const [ent] = await db
        .select({ rootAgentId: entities.rootAgentId })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);
      if (ent?.rootAgentId && ent.rootAgentId !== row.id) {
        await db.insert(agentAssignments).values({
          orchestratorId: ent.rootAgentId,
          subAgentId: row.id,
          entityId,
        });
      }
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

// ─── attachAgentToOrchestrator ────────────────────────────────────────────────

export type AttachAgentResult =
  | { ok: true; subAgentId: string; subAgentName: string }
  | { error: 'agent_not_found' | 'cannot_attach_self' };

/**
 * Assign an EXISTING agent as a sub-agent of an orchestrator (the ROOT caller).
 *
 * Resolves the target by slug OR name (case-insensitive ilike) within the
 * entity. Returns `{ error: 'agent_not_found' }` if no match. Returns
 * `{ error: 'cannot_attach_self' }` if the target resolves to the caller.
 * Idempotent: a SELECT guard ensures at most one assignment row per pair.
 */
export async function attachAgentToOrchestrator(
  db: AnyDrizzleDb,
  entityId: string,
  orchestratorId: string,
  agentSlugOrName: string,
): Promise<AttachAgentResult> {
  const [targetRow] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.entityId, entityId),
        or(eq(agents.slug, agentSlugOrName), ilike(agents.name, agentSlugOrName)),
      ),
    )
    .limit(1);

  if (!targetRow) {
    return { error: 'agent_not_found' };
  }

  if (targetRow.id === orchestratorId) {
    return { error: 'cannot_attach_self' };
  }

  // Idempotent: skip if the assignment row already exists.
  const existing = await db
    .select({ id: agentAssignments.id })
    .from(agentAssignments)
    .where(
      and(
        eq(agentAssignments.orchestratorId, orchestratorId),
        eq(agentAssignments.subAgentId, targetRow.id),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    await db.insert(agentAssignments).values({
      orchestratorId,
      subAgentId: targetRow.id,
      entityId,
    });
  }

  return { ok: true, subAgentId: targetRow.id, subAgentName: targetRow.name };
}

// ─── The agent's model ───────────────────────────────────────────────────────

/**
 * Why `model` cannot run a router or a planner, or null. An orchestrator
 * delegates by tool call: a model the catalog says has no tools can never hand
 * work to its team. Only a catalogued model is judged — an unknown one (a local
 * server, a model newer than the catalog) is the user's call. Shared by the
 * dashboard's create, edit and model screens and by the bench's applier.
 */
export async function orchestratorModelToolsError(
  db: AnyDrizzleDb,
  entityId: string,
  llmKeyId: string | null | undefined,
  model: string,
): Promise<string | null> {
  if (!llmKeyId) return null;
  const [key] = await db
    .select({ provider: entityLlmKeys.provider })
    .from(entityLlmKeys)
    .where(and(eq(entityLlmKeys.id, llmKeyId), eq(entityLlmKeys.entityId, entityId)));
  if (!key) return null;
  const entry = findModelCatalogEntry(key.provider, model);
  if (entry && !entry.capabilities.tools) {
    return `"${entry.label}" can't use tools — pick a tool-capable model for a router/planner.`;
  }
  return null;
}

export interface SetAgentModelInput {
  readonly agentId: string;
  readonly model: string;
  /** null = Auto (the provider's default). */
  readonly reasoningEffort: (typeof agents.$inferSelect)['reasoningEffort'];
  /** The primary key to set; undefined keeps the one the agent holds. */
  readonly llmKeyId?: string | null;
}

/**
 * Write an agent's primary model (and key, when given). The primary key can
 * never also be a fallback link — the agent would fail over onto itself — so
 * setting a key removes it from the chain. The agent must belong to the
 * workspace: anything else is refused, never written elsewhere.
 */
export async function setAgentModelRepo(
  db: AnyDrizzleDb,
  entityId: string,
  input: SetAgentModelInput,
): Promise<{ ok: true } | { error: 'agent_not_found' }> {
  const [agent] = await db
    .select({ id: agents.id, fallbackChain: agents.fallbackChain })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.entityId, entityId)));
  if (!agent) return { error: 'agent_not_found' };

  const patch: Partial<typeof agents.$inferInsert> = {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    updatedAt: new Date(),
  };
  if (input.llmKeyId !== undefined) {
    patch.llmKeyId = input.llmKeyId;
    patch.fallbackChain = (agent.fallbackChain ?? []).filter(
      (link) => link.keyId !== input.llmKeyId,
    );
  }
  await db
    .update(agents)
    .set(patch)
    .where(and(eq(agents.id, input.agentId), eq(agents.entityId, entityId)));
  return { ok: true };
}
