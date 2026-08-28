// channel_bindings — per-(agent, channel) bot/gateway credential + identity (S2).
//
// Generalizes agents.telegram_bot_token / telegram_bot_username / telegram_offset
// to any channel, so future channels (Discord, Slack, WhatsApp) don't grow
// their own set of hardcoded columns on `agents`. One row per (agent, channel):
//   - credentials: a JSON credential bag, ENCRYPTED AT REST since 2026-08-28
//     using the same `enc:v1:{iv}:{tag}:{ct}` convention as
//     entity_llm_keys.apiKey. Untyped `text` because the envelope is opaque to
//     Drizzle. Read it through getBindingCredentials (queries/
//     channel-identity.ts), which decrypts and still accepts a legacy
//     plaintext row; write it through encryptChannelCredentials so nothing
//     lands here in the clear.
//
//     An earlier version of this header claimed "@nodal-agents/db never
//     imports @nodal-agents/secrets (architecture rule — only the writer layer
//     does)" and deferred encryption to "S3+". That claim was FALSE:
//     queries/credentials.ts has imported `decrypt` since the OAuth credential
//     brique and packages/db/package.json declares the dependency; no
//     dependency-cruiser rule ever forbade it. The invented rule is the only
//     reason every bot token in this table — and in
//     agents.telegram_bot_token — sat in plaintext through the August 2026
//     Discord/Slack token leak. Do not reintroduce it.
//   - bot_identity: denormalized display info ({id, username, displayName}) so
//     UI reads don't need a channel-specific join.
//   - cursor: the channel's resume token (Telegram's getUpdates offset, a
//     gateway session id, etc.) — opaque to this table, channel adapters
//     interpret it.
//
// S2 transitional note: this table is back-filled once from `agents` at
// migration time but nothing keeps it live afterward — the Telegram runner
// still reads/writes agents.telegram_bot_token directly until S3 flips it to
// this table. See queries/channel-identity.ts for the read-side split.

import {
  pgTable,
  text,
  uuid,
  boolean,
  jsonb,
  timestamp,
  index,
  check,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const channelBindings = pgTable(
  'channel_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    /** The bot/gateway this binding belongs to. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** Opaque ciphertext (or plaintext JSON — see file header). */
    credentials: text('credentials').notNull(),
    /** {id, username, displayName} — all optional, channel-dependent. */
    botIdentity: jsonb('bot_identity').$type<{
      id?: string;
      username?: string;
      displayName?: string;
    } | null>(),
    /** Resume token: getUpdates offset, gateway session id, etc. */
    cursor: text('cursor'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique('channel_bindings_agent_channel_unique').on(table.agentId, table.channel),
    index('idx_channel_bindings_agent').on(table.agentId),
    index('idx_channel_bindings_entity').on(table.entityId),
    check(
      'channel_bindings_channel_check',
      sql`${table.channel} IN ('telegram','discord','slack','whatsapp')`,
    ),
  ],
);

export type ChannelBindingRow = typeof channelBindings.$inferSelect;
export type ChannelBindingInsert = typeof channelBindings.$inferInsert;
