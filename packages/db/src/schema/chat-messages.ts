// conversations + chat_messages — in-app chat store (V4).
//
// A conversation is NOT a job. Turns live in chat_messages, grouped under a
// `conversations` row (the sidebar entries). Pure chat never creates an
// agent_jobs row. When a turn escalates to an ACTION, that job's id is linked
// on the message (jobId) so the UI can show its progress inline.

import { pgTable, text, uuid, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    // The agent this conversation is with (the ROOT, today).
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    // Stamped at CREATION time (never rewritten later) so the onboarding
    // interview conversation never leaks into the dashboard's Chats list —
    // whether the operator skips it or finishes it (migration 0065).
    origin: text('origin').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    // Bumped on each new turn — drives the recency sort in the sidebar.
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_conversations_entity_agent').on(table.entityId, table.agentId, table.updatedAt),
    check('conversations_origin_check', sql`${table.origin} IN ('user','onboarding')`),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    // Set when this (assistant) turn escalated into a real action job — lets the
    // UI render the job's dispatch/progress inline. NULL for pure conversation.
    jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_chat_messages_conversation').on(table.conversationId, table.createdAt),
    check('chat_messages_role_check', sql`${table.role} IN ('user','assistant')`),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessageInsert = typeof chatMessages.$inferInsert;
