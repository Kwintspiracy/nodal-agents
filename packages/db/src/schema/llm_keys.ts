// entity_llm_keys table — per-entity LLM provider API key configuration

import { pgTable, text, uuid, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';

export const entityLlmKeys = pgTable(
  'entity_llm_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    apiKey: text('api_key').notNull().default(''),
    baseUrl: text('base_url'),
    nickname: text('nickname'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_entity_llm_keys_entity_id').on(table.entityId)],
);

// Unique constraint: (entity_id, provider) — enforced in migration SQL

export type EntityLlmKeyRow = typeof entityLlmKeys.$inferSelect;
export type EntityLlmKeyInsert = typeof entityLlmKeys.$inferInsert;
