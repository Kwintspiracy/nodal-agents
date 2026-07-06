// telegram_allowed_chats — inbound Telegram authorization (H-1).
//
// Gates who may talk to an agent's bot. A Telegram bot's username is
// discoverable, so without this ANY stranger who DMs the bot would spawn a job
// running with the agent's tools and connectors. Rules:
//   - The FIRST private chat to DM a bot with no owner yet becomes its OWNER
//     (role='owner', status='active') — the person who set the bot up.
//   - Any other unknown chat is inserted as a PENDING member and the owner is
//     asked to confirm (inline buttons) before it is allowed; until then its
//     messages never create a job.
// One row per (agent_id, chat_id).

import { pgTable, text, uuid, timestamp, index, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';

export const telegramAllowedChats = pgTable(
  'telegram_allowed_chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    /** The bot the chat is talking to (the RECEIVING agent). */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Telegram chat id (private chat, group, or supergroup) as a string. */
    chatId: text('chat_id').notNull(),
    /** 'owner' = the bot's controller; 'member' = an approved additional chat. */
    role: text('role').notNull().default('member'),
    /** 'active' = may create jobs; 'pending' = awaiting the owner's confirmation. */
    status: text('status').notNull().default('pending'),
    /** Display name of the requester, for the owner's confirmation card. */
    requesterName: text('requester_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    unique('telegram_allowed_chats_agent_chat_unique').on(table.agentId, table.chatId),
    index('idx_telegram_allowed_chats_agent').on(table.agentId),
    index('idx_telegram_allowed_chats_entity').on(table.entityId),
    check('telegram_allowed_chats_role_check', sql`${table.role} IN ('owner','member')`),
    check('telegram_allowed_chats_status_check', sql`${table.status} IN ('active','pending')`),
  ],
);

export type TelegramAllowedChatRow = typeof telegramAllowedChats.$inferSelect;
export type TelegramAllowedChatInsert = typeof telegramAllowedChats.$inferInsert;
