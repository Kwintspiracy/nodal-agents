// connectors table — holds API keys and OAuth tokens per entity per provider

import { pgTable, text, uuid, boolean, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';

export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    baseUrl: text('base_url'),
    // Encrypted with pgp_sym_encrypt in DB — raw value never returned in select
    apiKey: text('api_key'),
    active: boolean('active').default(true),
    authType: text('auth_type').notNull().default('api_key'),
    oauthClientId: text('oauth_client_id'),
    oauthClientSecret: text('oauth_client_secret'),
    oauthRefreshToken: text('oauth_refresh_token'),
    oauthAccessToken: text('oauth_access_token'),
    oauthTokenExpiresAt: timestamp('oauth_token_expires_at', { withTimezone: true }),
    oauthTokenUrl: text('oauth_token_url'),
    oauthScopes: text('oauth_scopes'),
    oauthAccountName: text('oauth_account_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_connectors_entity_id').on(table.entityId),
    check(
      'connectors_auth_type_check',
      sql`${table.authType} IN ('api_key','oauth2','bearer','basic','none')`,
    ),
  ],
);

export type ConnectorRow = typeof connectors.$inferSelect;
export type ConnectorInsert = typeof connectors.$inferInsert;
