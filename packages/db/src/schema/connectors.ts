// connectors table — holds API keys per entity per provider.
// OAuth tokens are now stored in the credentials table (credential_id FK).

import { pgTable, text, uuid, boolean, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { credentials } from './credentials.ts';

export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    baseUrl: text('base_url'),
    // Encrypted with pgp_sym_encrypt in DB — raw value never returned in select
    apiKey: text('api_key'),
    active: boolean('active').default(true),
    authType: text('auth_type').notNull().default('api_key'),
    // FK to credentials table — set null when credential is deleted
    credentialId: uuid('credential_id').references(() => credentials.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_connectors_entity_id').on(table.entityId),
    index('idx_connectors_credential_id').on(table.credentialId),
    check(
      'connectors_auth_type_check',
      sql`${table.authType} IN ('api_key','oauth2','bearer','basic','none')`,
    ),
    // Multi-instance brique (migration 0016): the (entity_id, slug) UNIQUE
    // constraint was dropped to allow multiple instances of the same connector
    // type per entity (e.g. several Gmail accounts).
  ],
);

export type ConnectorRow = typeof connectors.$inferSelect;
export type ConnectorInsert = typeof connectors.$inferInsert;
