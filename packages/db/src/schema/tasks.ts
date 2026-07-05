// agent_tasks table

import {
  pgTable,
  text,
  uuid,
  integer,
  jsonb,
  timestamp,
  numeric,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    orchestratorId: uuid('orchestrator_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('todo'),
    priority: text('priority').notNull().default('medium'),
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    result: text('result'),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
    assignedAgentId: uuid('assigned_agent_id').references(() => agents.id, {
      onDelete: 'cascade',
    }),
    inputTokens: integer('input_tokens').default(0),
    outputTokens: integer('output_tokens').default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).default('0'),
    dependsOn: uuid('depends_on')
      .array()
      .default(sql`'{}'::uuid[]`),
    context: jsonb('context').default(sql`'{}'::jsonb`),
    rootJobId: uuid('root_job_id'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_agent_tasks_entity').on(table.entityId),
    index('idx_agent_tasks_entity_status_created').on(
      table.entityId,
      table.status,
      sql`${table.createdAt} DESC`,
    ),
    index('idx_agent_tasks_orchestrator_status').on(table.orchestratorId, table.status),
    index('idx_agent_tasks_status').on(table.status),
    index('idx_agent_tasks_assigned').on(table.assignedAgentId),
    // DB-3 (audit #2): findUndeliveredRootJobIds (apps/runner/src/cron/
    // deliver-results.ts) scans `WHERE root_job_id IS NOT NULL` on every cron
    // tick and had no index to support it — full scan on the hottest task table.
    index('idx_agent_tasks_root_job_id').on(table.rootJobId),
    check(
      'agent_tasks_status_check',
      sql`${table.status} IN ('todo','in_progress','done','cancelled','blocked')`,
    ),
    check('agent_tasks_priority_check', sql`${table.priority} IN ('low','medium','high')`),
    check('agent_tasks_title_check', sql`char_length(${table.title}) <= 200`),
    check(
      'agent_tasks_description_check',
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 2000`,
    ),
  ],
);

export type AgentTaskRow = typeof agentTasks.$inferSelect;
export type AgentTaskInsert = typeof agentTasks.$inferInsert;
