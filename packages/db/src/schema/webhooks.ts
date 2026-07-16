// webhook_triggers table

import { pgTable, text, uuid, boolean, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const webhookTriggers = pgTable(
  'webhook_triggers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    taskTemplate: text('task_template').notNull(),
    active: boolean('active').default(true),
    // default: random 32-char hex (generated in app layer for Nodal-Agents)
    secret: text('secret'),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    triggerCount: integer('trigger_count').default(0),
    // B2 (notify-channel-choice plan): same pair of columns as
    // agent_schedules (see schedules.ts), same mechanic — the schedules
    // brique (B1) established the pattern, this just closes the gap the plan
    // identified: webhooks had no notify at all, not by design, just because
    // the original webhooks brique scoped delivery to the HTTP caller (202 +
    // jobId) and never to the owner. Default false → firing stays silent
    // unless opted in per trigger.
    notifyOnSuccess: boolean('notify_on_success').notNull().default(false),
    // Explicit notify channel choice, NULL = auto (first active channel by
    // CHANNEL_PRIORITY — see routes/webhook.ts). Unlike agent_schedules,
    // there is no legacy webhook-notify behavior to preserve, so "auto" here
    // is a plain first-active-channel resolution from the start (no
    // telegram-only wrapper).
    notifyChannel: text('notify_channel'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_webhook_triggers_entity_id').on(table.entityId),
    check(
      'webhook_triggers_notify_channel_check',
      sql`${table.notifyChannel} IN ('telegram','discord','slack','whatsapp') OR ${table.notifyChannel} IS NULL`,
    ),
  ],
);

export type WebhookTriggerRow = typeof webhookTriggers.$inferSelect;
export type WebhookTriggerInsert = typeof webhookTriggers.$inferInsert;
