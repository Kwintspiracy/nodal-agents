// entity_llm_keys table — per-entity LLM provider API key configuration

import { pgTable, text, uuid, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { entities } from './entities.ts';

export const entityLlmKeys = pgTable(
  'entity_llm_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    // Encrypted at rest via @nodal-agents/secrets (AES-256-GCM). Format:
    //   - '' for absent key (no encryption applied)
    //   - 'enc:v1:{iv}:{tag}:{ct}' for present key (base64 segments)
    apiKey: text('api_key').notNull().default(''),
    // Plaintext last 4 chars of the original key, populated at write-time.
    // Cached separately because RIGHT(apiKey, 4) on the ciphertext yields garbage.
    apiKeyLast4: text('api_key_last4').notNull().default(''),
    baseUrl: text('base_url'),
    nickname: text('nickname'),
    // Real context window (tokens) for a custom/local model the catalog can't
    // know (É-3). Auto-detected from the endpoint at save time or set by the
    // user; NULL ⇒ fall back to the catalogued value or DEFAULT_CONTEXT_WINDOW.
    // Used window-relative to trigger compaction before the model overflows.
    contextWindow: integer('context_window'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_entity_llm_keys_entity_id').on(table.entityId)],
);

// Multiple configs per provider are allowed (e.g. one Anthropic key for prod,
// another for dev) — no unique constraint on (entity_id, provider).

export type EntityLlmKeyRow = typeof entityLlmKeys.$inferSelect;
export type EntityLlmKeyInsert = typeof entityLlmKeys.$inferInsert;
