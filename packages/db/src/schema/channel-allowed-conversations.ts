// channel_allowed_conversations — channel-neutral inbound authorization (S2).
//
// Generalizes telegram_allowed_chats (H-1) to any channel. Same security
// model: the FIRST private conversation to reach an agent's bot with no owner
// yet becomes its OWNER (role='owner', status='active'); any other unknown
// conversation is inserted PENDING until the owner approves it. One row per
// (agent_id, channel, conversation_id).
//
// S2 transitional note (see queries/channel-identity.ts): this table is
// back-filled ONCE from telegram_allowed_chats at migration time, but the
// Telegram inbound handler still WRITES to telegram_allowed_chats (owner-claim,
// pending-approval flow — untouched in this brique), so a row inserted here
// for channel='telegram' after the back-fill would never happen and existing
// rows would drift stale. Reads for channel='telegram' therefore go straight
// to telegram_allowed_chats until S3 flips the writers over; every OTHER
// channel reads this table as its only source of truth.

import {
  pgTable,
  text,
  uuid,
  timestamp,
  index,
  check,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const channelAllowedConversations = pgTable(
  'channel_allowed_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    /** The bot/gateway the conversation is talking to (the RECEIVING agent). */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** Channel-native conversation id (Telegram chat id, Discord channel id, etc.) as a string. */
    conversationId: text('conversation_id').notNull(),
    /** 'private' = 1:1 DM; 'group'/'channel'/'thread' = multi-party surfaces. */
    kind: text('kind').notNull().default('private'),
    /** 'owner' = the bot's controller; 'member' = an approved additional conversation. */
    role: text('role').notNull().default('member'),
    /** 'active' = may create jobs; 'pending' = awaiting the owner's confirmation. */
    status: text('status').notNull().default('pending'),
    /** Display name of the requester, for the owner's confirmation card. */
    requesterName: text('requester_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique('channel_allowed_conversations_agent_channel_conversation_unique').on(
      table.agentId,
      table.channel,
      table.conversationId,
    ),
    index('idx_channel_allowed_conversations_agent').on(table.agentId),
    index('idx_channel_allowed_conversations_entity').on(table.entityId),
    check(
      'channel_allowed_conversations_channel_check',
      sql`${table.channel} IN ('telegram','discord','slack','whatsapp')`,
    ),
    check(
      'channel_allowed_conversations_kind_check',
      sql`${table.kind} IN ('private','group','channel','thread')`,
    ),
    check('channel_allowed_conversations_role_check', sql`${table.role} IN ('owner','member')`),
    check(
      'channel_allowed_conversations_status_check',
      sql`${table.status} IN ('active','pending')`,
    ),
    // Mirrors telegram_allowed_chats_single_owner (migration 0060): at most one
    // active-owner-authority row per (agent, channel) — same race this closes
    // (concurrent first-contact claims), scoped so each channel gets its OWN
    // owner rather than sharing one across an agent's whole multichannel surface.
    uniqueIndex('channel_allowed_conversations_single_owner')
      .on(table.agentId, table.channel)
      .where(sql`${table.role} = 'owner'`),
  ],
);

export type ChannelAllowedConversationRow = typeof channelAllowedConversations.$inferSelect;
export type ChannelAllowedConversationInsert = typeof channelAllowedConversations.$inferInsert;
