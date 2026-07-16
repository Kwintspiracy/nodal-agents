// agent_schedules table

import { pgTable, text, uuid, boolean, real, timestamp, index, check } from 'drizzle-orm/pg-core';
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
    // IANA timezone the cron is evaluated in (e.g. 'Asia/Singapore'). null = the
    // server's local timezone (legacy rows). New schedules capture an explicit tz
    // so "9am" stays 9am in the user's zone regardless of where the runner hosts.
    timezone: text('timezone'),
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
    // Explicit notify channel choice (B1, notify-channel-choice plan). One of
    // 'telegram'|'discord'|'slack'|'whatsapp', or NULL = auto (the historical
    // behavior: first active channel by CHANNEL_PRIORITY — see run-schedules.ts).
    // Choosing a channel here LINKS chatId resolution to it: the owner
    // conversation resolved at fire time is the owner's conversation ON THIS
    // CHANNEL, not whichever channel happened to win priority. 'whatsapp' is
    // accepted at the DB layer for forward-compat but the UI does not offer it
    // yet — no outbound send tool exists for whatsapp (TOOL_ONLY_DELIVERY_CHANNELS,
    // execute.ts), so a whatsapp notify would only ever reach the user through
    // deliver-results.ts's adapter-direct path, never a mid-run agent send.
    notifyChannel: text('notify_channel'),
    // Per-schedule daily cost ceiling in USD (Event Triggers, Brique 3). Rolled
    // up against agent_jobs.total_cost_usd for this schedule since the start
    // of its local day — see runScheduleTick (apps/runner/src/cron/run-schedules.ts).
    // Default 5.0: generous enough not to surprise existing schedules, small
    // enough to bound the worst case a frequent watcher can burn.
    dailyBudgetUsd: real('daily_budget_usd').notNull().default(5.0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_agent_schedules_entity_id').on(table.entityId),
    index('idx_schedules_active').on(table.active, table.nextRun),
    check('agent_schedules_type_check', sql`${table.type} IN ('cron','heartbeat')`),
    check(
      'agent_schedules_last_status_check',
      sql`${table.lastStatus} IN ('success','failed','no_action','budget_exhausted','notify_unreachable') OR ${table.lastStatus} IS NULL`,
    ),
    check(
      'agent_schedules_notify_channel_check',
      sql`${table.notifyChannel} IN ('telegram','discord','slack','whatsapp') OR ${table.notifyChannel} IS NULL`,
    ),
  ],
);

export type AgentScheduleRow = typeof agentSchedules.$inferSelect;
export type AgentScheduleInsert = typeof agentSchedules.$inferInsert;
