// @nodal-agents/memory — CRUD operations on agent_memory

import { eq, and } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { agentMemory } from '@nodal-agents/db';
import type { AgentMemory, AgentMemoryInsert } from '@nodal-agents/shared';
import { AgentMemoryInsertSchema } from '@nodal-agents/shared';
import { MemoryNotFoundError } from './errors';

// ─── Get ───────────────────────────────────────────────────────────────────────

export async function getMemory(
  db: AnyDrizzleDb,
  id: string,
  entityId: string,
): Promise<AgentMemory> {
  const rows = await db
    .select()
    .from(agentMemory)
    .where(and(eq(agentMemory.id, id), eq(agentMemory.entityId, entityId)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new MemoryNotFoundError(id);
  }
  return rowToMemory(row as MemoryRow);
}

// ─── Create ────────────────────────────────────────────────────────────────────

export async function createMemory(
  db: AnyDrizzleDb,
  input: AgentMemoryInsert,
): Promise<AgentMemory> {
  const parsed = AgentMemoryInsertSchema.parse(input);

  const rows = await db
    .insert(agentMemory)
    .values({
      entityId: parsed.entity_id ?? null,
      agentId: parsed.agent_id ?? null,
      fact: parsed.fact,
      category: parsed.category,
      importance: parsed.importance,
      source: parsed.source,
      skillTags: parsed.skill_tags,
      memoryLayer: parsed.memory_layer ?? null,
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error('memory.create_failed');
  }
  return rowToMemory(row as MemoryRow);
}

// ─── Update ────────────────────────────────────────────────────────────────────

export async function updateMemory(
  db: AnyDrizzleDb,
  id: string,
  entityId: string,
  updates: Partial<
    Pick<AgentMemory, 'fact' | 'category' | 'importance' | 'skill_tags' | 'archived' | 'valid_to'>
  >,
): Promise<AgentMemory> {
  const payload: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (updates.fact !== undefined) payload['fact'] = updates.fact;
  if (updates.category !== undefined) payload['category'] = updates.category;
  if (updates.importance !== undefined) payload['importance'] = updates.importance;
  if (updates.skill_tags !== undefined) payload['skillTags'] = updates.skill_tags;
  if (updates.archived !== undefined) payload['archived'] = updates.archived;
  if (updates.valid_to !== undefined) {
    payload['validTo'] = updates.valid_to ? new Date(updates.valid_to) : null;
  }

  const rows = await db
    .update(agentMemory)
    .set(payload)
    .where(and(eq(agentMemory.id, id), eq(agentMemory.entityId, entityId)))
    .returning();

  const row = rows[0];
  if (!row) {
    throw new MemoryNotFoundError(id);
  }
  return rowToMemory(row as MemoryRow);
}

// ─── Delete ────────────────────────────────────────────────────────────────────

export async function deleteMemory(db: AnyDrizzleDb, id: string, entityId: string): Promise<void> {
  const rows = await db
    .delete(agentMemory)
    .where(and(eq(agentMemory.id, id), eq(agentMemory.entityId, entityId)))
    .returning();

  if (rows.length === 0) {
    throw new MemoryNotFoundError(id);
  }
}

// ─── Row mapper ────────────────────────────────────────────────────────────────

// Internal type alias for the DB row shape returned by drizzle selects
export type MemoryRow = typeof agentMemory.$inferSelect;

export function rowToMemory(row: MemoryRow): AgentMemory {
  return {
    id: row.id,
    entity_id: row.entityId ?? null,
    agent_id: row.agentId ?? null,
    fact: row.fact,
    category: (row.category ?? 'context') as AgentMemory['category'],
    importance: row.importance ?? 3,
    source: (row.source ?? 'agent') as AgentMemory['source'],
    skill_tags: (row.skillTags as string[]) ?? [],
    memory_layer: (row.memoryLayer ?? null) as AgentMemory['memory_layer'],
    valid_from: row.validFrom?.toISOString() ?? null,
    valid_to: row.validTo?.toISOString() ?? null,
    fact_hash: row.factHash ?? null,
    archived: row.archived ?? false,
    last_accessed_at: row.lastAccessedAt?.toISOString() ?? null,
    access_count: row.accessCount ?? 0,
    created_at: row.createdAt?.toISOString() ?? new Date().toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}
