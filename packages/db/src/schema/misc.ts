// Miscellaneous tables: configurator_sessions, agent_plugins, rate_limits

import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  check,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

// ─── configurator_sessions ────────────────────────────────────────────────────

export const configuratorSessions = pgTable(
  'configurator_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    messages: jsonb('messages')
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('active'),
    turnCount: integer('turn_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_configurator_sessions_entity').on(table.entityId),
    index('idx_configurator_sessions_agent').on(table.agentId),
  ],
);

export type ConfiguratorSessionRow = typeof configuratorSessions.$inferSelect;
export type ConfiguratorSessionInsert = typeof configuratorSessions.$inferInsert;

// ─── agent_plugins ────────────────────────────────────────────────────────────

export const agentPlugins = pgTable(
  'agent_plugins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    pluginType: text('plugin_type').notNull(),
    config: jsonb('config').default(sql`'{}'::jsonb`),
    active: boolean('active').default(true),
    hook: text('hook').notNull(),
    webhookUrl: text('webhook_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    check(
      'agent_plugins_plugin_type_check',
      sql`${table.pluginType} IN ('webhook','transform','schedule')`,
    ),
    check(
      'agent_plugins_hook_check',
      sql`${table.hook} IN ('pre_task','post_task','pre_tool','post_tool','on_memory_save')`,
    ),
    // R5 (audit #2 follow-up): the pglite test DDL (packages/db/src/tests/
    // helpers.ts) already assumed a per-entity unique slug here — same class
    // of phantom-constraint bug as DB-2/F-18 (test mock ahead of the real
    // schema/migration). entityId is nullable (no `.notNull()` above), so
    // NULLS NOT DISTINCT closes the same NULL-entity gap as DB-1's
    // approval_rules constraint.
    unique('agent_plugins_entity_slug_unique').on(table.entityId, table.slug).nullsNotDistinct(),
  ],
);

export type AgentPluginRow = typeof agentPlugins.$inferSelect;
export type AgentPluginInsert = typeof agentPlugins.$inferInsert;

// ─── rate_limits ──────────────────────────────────────────────────────────────

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').default(1),
  windowStart: timestamp('window_start', { withTimezone: true }).defaultNow(),
});

export type RateLimitRow = typeof rateLimits.$inferSelect;
export type RateLimitInsert = typeof rateLimits.$inferInsert;
