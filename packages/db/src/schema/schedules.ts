// agent_schedules table

import { pgTable, text, uuid, boolean, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const agentSchedules = pgTable(
  'agent_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('cron'),
    name: text('name').notNull(),
    cronExpr: text('cron_expr').notNull(),
    task: text('task'),
    objectives: text('objectives'),
    active: boolean('active').default(true),
    lastRun: timestamp('last_run', { withTimezone: true }),
    nextRun: timestamp('next_run', { withTimezone: true }),
    lastStatus: text('last_status'),
    chatId: text('chat_id'),
    // Opt-in: when true, a fired job carries a delivery target so the runner
    // forces the agent to send the user a success confirmation before finishing.
    // Default false → the cron runs silently (the user must opt in per schedule).
    notifyOnSuccess: boolean('notify_on_success').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_schedules_entity_id').on(table.entityId),
    index('idx_schedules_active').on(table.active, table.nextRun),
    check('agent_schedules_type_check', sql`${table.type} IN ('cron','heartbeat')`),
    check(
      'agent_schedules_last_status_check',
      sql`${table.lastStatus} IN ('success','failed','no_action') OR ${table.lastStatus} IS NULL`,
    ),
  ],
);

export type AgentScheduleRow = typeof agentSchedules.$inferSelect;
export type AgentScheduleInsert = typeof agentSchedules.$inferInsert;
