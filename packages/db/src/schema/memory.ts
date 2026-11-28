// agent_memory table — includes pgvector embedding column

import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  timestamp,
  customType,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

// pgvector: use customType for compatibility across drizzle-orm patch versions.
// The in-process tests use pglite's vector extension to exercise this column.
const vectorType = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    // config is typed as 'unknown' by drizzle-orm's customType signature
    const dims = (config as Record<string, unknown> | undefined)?.['dimensions'] ?? 1536;
    return `vector(${dims})`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[];
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

export const agentMemory = pgTable(
  'agent_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * Full-text source. A generated `search_tsv tsvector` column + GIN index
     * (raw SQL, migration 0051 — not expressible in the Drizzle schema builder,
     * same pattern as agent_jobs.search_tsv / migration 0050) makes this fact
     * rankable by relevance. Powers memory injection (selectMemoriesForInjection)
     * and the `query_memory` builtin (keywordSearchMemories) via ts_rank.
     * Config is `'english'` (stemming — "tokens" matches a "token" query),
     * unlike agent_jobs.search_tsv which stays `'simple'`.
     */
    fact: text('fact').notNull(),
    category: text('category').default('context'),
    importance: integer('importance').default(3),
    source: text('source').default('agent'),
    skillTags: text('skill_tags')
      .array()
      .default(sql`'{}'::text[]`),
    memoryLayer: text('memory_layer'),
    embedding: vectorType('embedding', { dimensions: 1536 }),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    factHash: text('fact_hash'),
    archived: boolean('archived').default(false),
    /**
     * User override lock (migration 0053). When true, the curator's
     * usage-driven re-scoring MUST refuse to touch importance — a user-pinned
     * value wins over the agent's guess and the curator's correction.
     */
    importanceLocked: boolean('importance_locked').notNull().default(false),
    /**
     * The row's version (migration 0172). Every change to a fact after it was
     * saved goes through `mutateMemory` (packages/memory/src/mutate.ts), which
     * states the version it read, applies only if the row is still that one,
     * bumps this number and keeps the previous state in
     * `agent_memory_versions`. Usage counters and the derived vector are not
     * part of the fact and do not bump it.
     */
    version: integer('version').notNull().default(1),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).defaultNow(),
    accessCount: integer('access_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_memory_entity_id').on(table.entityId),
    index('idx_agent_memory_entity_active').on(table.entityId, table.archived, table.validTo),
    index('idx_agent_memory_archived').on(table.archived),
    index('idx_agent_memory_last_accessed').on(table.lastAccessedAt),
    index('idx_agent_memory_layer').on(table.memoryLayer),
    index('idx_agent_memory_fact_hash').on(table.factHash),
    index('idx_memory_category').on(table.category, sql`${table.importance} DESC`),
    // Note: ivfflat index for embedding added via raw SQL in migration (not supported by Drizzle schema builder)
    check(
      'agent_memory_category_check',
      sql`${table.category} IN ('preference','context','outcome','learned_rule')`,
    ),
    check(
      'agent_memory_importance_check',
      sql`${table.importance} >= 1 AND ${table.importance} <= 5`,
    ),
    check('agent_memory_source_check', sql`${table.source} IN ('agent','reflection','manual')`),
  ],
);

/**
 * agent_memory_versions (migration 0172): the state a fact had BEFORE each
 * change, one row per change, written by `mutateMemory` in the same
 * transaction as the change. `version` is the version that state carried; the
 * fact moved to `version + 1`. `changed_by` names who or what made the change,
 * `agent_id` the agent when an agent made it. Putting a version back is itself
 * a change, so it is kept too.
 */
export const agentMemoryVersions = pgTable(
  'agent_memory_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => agentMemory.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    fact: text('fact').notNull(),
    category: text('category'),
    importance: integer('importance'),
    importanceLocked: boolean('importance_locked').notNull(),
    archived: boolean('archived').notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    changedBy: text('changed_by').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_agent_memory_versions_memory').on(table.memoryId, sql`${table.version} DESC`),
    check(
      'agent_memory_versions_changed_by_check',
      sql`${table.changedBy} IN ('owner','agent','curator','lifecycle')`,
    ),
    check(
      'agent_memory_versions_action_check',
      sql`${table.action} IN ('edit','archive','retire','restore','rescore','pin','unpin','revert')`,
    ),
  ],
);

export type AgentMemoryRow = typeof agentMemory.$inferSelect;
export type AgentMemoryVersionRow = typeof agentMemoryVersions.$inferSelect;
export type AgentMemoryInsert = typeof agentMemory.$inferInsert;
