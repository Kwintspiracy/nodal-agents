// app_settings — machine-global key/value settings (one row per key), editable
// at runtime via the dashboard and read LIVE by the runner. Distinct from
// config.json (CLI-managed, restart-gated): these change without a restart.
//
// entity_settings — same shape, scoped per workspace (entity). Used for
// settings that must NOT cross entity boundaries even though they're edited
// through the same "operator" flow — e.g. install notes (M-2, audit #2):
// a value written by one entity's owner must never be injected into another
// entity's agents.

import { pgTable, text, uuid, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').default('').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AppSettingRow = typeof appSettings.$inferSelect;

export const entitySettings = pgTable(
  'entity_settings',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').default('').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.entityId, table.key] })],
);

export type EntitySettingRow = typeof entitySettings.$inferSelect;
