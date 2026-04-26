// agent_runs table — historical execution record (denormalized from job)

import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id),
    task: text('task').notNull(),
    result: text('result'),
    success: boolean('success').default(true),
    toolsUsed: text('tools_used')
      .array()
      .default(sql`'{}'::text[]`),
    tokensUsed: integer('tokens_used'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    keySource: text('key_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_runs_entity_id').on(table.entityId),
    index('idx_agent_runs_agent_created').on(table.agentId, sql`${table.createdAt} DESC`),
    index('idx_runs_agent').on(table.agentId, sql`${table.createdAt} DESC`),
    index('idx_runs_recent').on(sql`${table.createdAt} DESC`),
    check(
      'agent_runs_key_source_check',
      sql`${table.keySource} IN ('entity','operator') OR ${table.keySource} IS NULL`,
    ),
  ],
);

export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentRunInsert = typeof agentRuns.$inferInsert;
