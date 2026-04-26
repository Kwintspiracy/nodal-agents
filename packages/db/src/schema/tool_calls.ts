// tool_calls table — individual tool invocations within a job

import { pgTable, text, uuid, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agentJobs } from './jobs.ts';

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input'),
    toolOutput: text('tool_output'),
    durationMs: integer('duration_ms'),
    turn: integer('turn'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_tool_calls_entity_id').on(table.entityId),
    index('idx_tool_calls_job').on(table.jobId),
    index('idx_tool_calls_job_created').on(table.jobId, sql`${table.createdAt} DESC`),
    index('idx_tool_calls_recent').on(sql`${table.createdAt} DESC`),
  ],
);

export type ToolCallRow = typeof toolCalls.$inferSelect;
export type ToolCallInsert = typeof toolCalls.$inferInsert;
