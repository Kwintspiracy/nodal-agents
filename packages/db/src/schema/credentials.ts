// credentials table — first-class credential entity (n8n-style)
// Stores encrypted OAuth payload; reusable across multiple connectors.

import { pgTable, text, uuid, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.ts';

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(), // encrypted JSON blob (enc:v1:...)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_credentials_owner').on(table.ownerUserId),
    index('idx_credentials_type').on(table.type),
    check(
      'credentials_type_check',
      sql`${table.type} IN ('google-oauth','notion-oauth','airtable-oauth')`,
    ),
  ],
);

export type CredentialRow = typeof credentials.$inferSelect;
export type CredentialInsert = typeof credentials.$inferInsert;
