// conversations + chat_messages — in-app chat store (V4).
//
// A conversation is NOT a job. Turns live in chat_messages, grouped under a
// `conversations` row (the sidebar entries). Pure chat never creates an
// agent_jobs row. When a turn escalates to an ACTION, that job's id is linked
// on the message (jobId) so the UI can show its progress inline.
//
// Depuis la migration 0094 (P6), `conversations` est la table de TOUTES les
// conversations, tous canaux : un fil Telegram, Slack, Discord ou WhatsApp a sa
// ligne au même titre qu'une conversation du dashboard. Les tours d'une
// conversation de CANAL ne vivent pas dans `chat_messages` — ce sont des
// `agent_jobs` de tête portant `conversation_id`. La ligne existe pour deux
// raisons : donner au fil une identité que l'utilisateur contrôle (elle dure
// jusqu'à ce qu'il en ouvre une autre, `/new` ou le « + »), et lui donner un
// endroit où porter un état durable — aujourd'hui le projet courant.

import { pgTable, text, uuid, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';
import { agents } from './agents.ts';
import { agentJobs } from './jobs.ts';
import { codeProjects } from './code-projects.ts';

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
    //
    // `project` (0097) : ouverte DEPUIS la page d'un projet. C'est ce fil-là
    // que la saisie du bas de cette page prolonge — la récence ne suffisait
    // pas, une conversation simplement ancrée par une production finissait par
    // évincer celle qu'on avait ouverte exprès. Elle reste une conversation de
    // l'utilisateur partout ailleurs ; seul `onboarding` est tenu hors listes.
    origin: text('origin').notNull().default('user'),
    /**
     * Le canal du fil (0094). `dashboard` par DÉFAUT — c'est ce qui laisse
     * `createConversationAction` inchangé, et ce qui donne son canal à chaque
     * ligne existante au moment de la migration.
     */
    channel: text('channel').notNull().default('dashboard'),
    /**
     * L'identifiant du fil SUR le canal (chat Telegram, canal Slack, ...).
     * NULL pour le dashboard, dont le fil n'existe nulle part ailleurs qu'ici.
     */
    chatId: text('chat_id'),
    /**
     * Le PROJET COURANT de la conversation (P6) : posé quand une production
     * atterrit dans un projet enregistré (attach.ts), et redit au modèle à
     * chaque tour dans le bloc `## Conversation`. TOUJOURS écrasé — la dernière
     * production décide, parce qu'une conversation qui change de sujet change
     * de dossier, et que l'utilisateur ne devrait pas avoir à le déclarer.
     * SET NULL : désinscrire un projet retire l'ancrage, jamais la conversation.
     */
    currentProjectId: uuid('current_project_id').references(() => codeProjects.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    // Bumped on each new turn — drives the recency sort in the sidebar.
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('idx_conversations_entity_agent').on(table.entityId, table.agentId, table.updatedAt),
    /**
     * LA requête du runner à chaque message entrant : la ligne la plus récente
     * du tuple (entité, agent, canal, chat).
     */
    index('idx_conversations_thread').on(
      table.entityId,
      table.agentId,
      table.channel,
      table.chatId,
      table.createdAt,
    ),
    check('conversations_origin_check', sql`${table.origin} IN ('user','onboarding','project')`),
    check(
      'conversations_channel_check',
      sql`${table.channel} IN ('dashboard','telegram','slack','discord','whatsapp')`,
    ),
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
