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

export type AgentMemoryRow = typeof agentMemory.$inferSelect;
export type AgentMemoryInsert = typeof agentMemory.$inferInsert;
