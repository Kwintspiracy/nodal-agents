// webhook_triggers table

import { pgTable, text, uuid, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('idx_webhook_triggers_entity_id').on(table.entityId)],
);

export type WebhookTriggerRow = typeof webhookTriggers.$inferSelect;
export type WebhookTriggerInsert = typeof webhookTriggers.$inferInsert;
