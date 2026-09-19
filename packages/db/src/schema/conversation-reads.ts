// conversation-reads — LE MARQUEUR DE LECTURE d'une personne sur un fil (#209).
//
// Jusqu'au 19/09/2026 le produit ne gardait AUCUN état de lecture, et c'était
// dit partout où ça se voyait : le point d'un fil dans la barre latérale ne
// pouvait signifier que « quelque chose attend » ou « un run tourne », et la
// pastille « Unread » de la planche n'était pas dessinée. Cette table est ce
// qui manquait.
//
// UNE LIGNE PAR (PERSONNE, CONVERSATION), et pas une colonne sur
// `conversations` : une lecture appartient à celui qui lit. Le fil que le
// propriétaire vient d'ouvrir n'est pas lu par son associé, et une colonne
// unique aurait fait taire le second dès que le premier passe.
//
// `read_at` est POSÉ, jamais avancé par le runner : seule l'ouverture du fil
// sur le tableau de bord l'écrit (`getConversationThreadAction`). Une livraison
// de canal ne marque rien — personne n'a lu quoi que ce soit parce qu'un
// message est parti sur Telegram.
//
// NON LU se déduit de deux colonnes, sans troisième : la conversation porte un
// `updated_at` que chaque réponse d'agent et chaque message entrant avancent
// (run-chat-turn.ts, conversation-id.ts). Un fil est non lu quand ce temps
// dépasse `read_at`, ou qu'aucune ligne n'existe ici. La règle vit en UN seul
// endroit côté lecture : apps/web/src/lib/unread.ts.

import { pgTable, uuid, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from './users.ts';
import { conversations } from './chat-messages.ts';

export const conversationReads = pgTable(
  'conversation_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Quand cette personne a ouvert ce fil pour la dernière fois. */
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // L'ordre compte : (personne, fil). Toutes les lectures groupées joignent
    // les marqueurs d'UNE personne, et cet index les leur donne entiers.
    primaryKey({ columns: [table.userId, table.conversationId] }),
    // L'autre sens — tous les marqueurs d'UN fil. PostgreSQL n'indexe pas les
    // clés étrangères tout seul, et la cascade d'une conversation supprimée
    // balaierait la table sans lui.
    index('idx_conversation_reads_conversation').on(table.conversationId),
  ],
);

export type ConversationReadRow = typeof conversationReads.$inferSelect;
export type ConversationReadInsert = typeof conversationReads.$inferInsert;
