// conversation_handles — L'ADRESSE qu'un modèle lit pour une conversation de
// canal (#824).
//
// Un texte qui part chez un fournisseur de modèle nomme une conversation par
// un identifiant OPAQUE, jamais par l'identifiant que le canal lui donne : une
// conversation WhatsApp directe s'appelle `<téléphone>@s.whatsapp.net`, et le
// numéro partait chez le fournisseur partout où le modèle lisait l'adresse.
// Le handle ne dit rien de l'identifiant : il est tiré au hasard, jamais
// dérivé (le hachage d'un numéro de téléphone se renverse par énumération).
//
// UNE LIGNE PAR (ENTITÉ, CANAL, CONVERSATION). L'entité, pas l'agent : c'est
// l'unité qui possède une conversation pour ses agents — la liste
// d'autorisation se lit par l'entité OU l'agent (`isConversationAllowed`), un
// délégué hérite du chat de son parent dans la même entité, et deux bots d'un
// même propriétaire sur une même conversation doivent donner UN handle, pas
// deux. Une ligne d'autorisation ne pouvait pas servir : elle est par agent
// receveur, change d'id quand on la supprime et la recrée, et n'existe pas
// pour une conversation découverte mais pas encore approuvée.
//
// Une ligne naît la première fois que le runner montre cette adresse à un
// modèle (`conversationHandlesFor`, queries/conversation-handles.ts), et ne
// change plus : ni `/new`, ni une autorisation recréée, ni un redémarrage.

import { pgTable, text, uuid, timestamp, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entities } from './entities.ts';

export const conversationHandles = pgTable(
  'conversation_handles',
  {
    /** Le handle lui-même : `conv_` puis 10 caractères base32 tirés au hasard. */
    id: text('id').primaryKey(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    /** Le canal de la conversation (telegram, discord, slack, whatsapp…). */
    channel: text('channel').notNull(),
    /** L'identifiant que le canal donne à la conversation. Jamais lu par un modèle. */
    conversationId: text('conversation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('conversation_handles_entity_channel_conversation_unique').on(
      table.entityId,
      table.channel,
      table.conversationId,
    ),
    // La forme est gardée en base : un handle ne ressemble à l'identifiant
    // d'aucun canal, et aucun écrivain n'y glisse autre chose.
    check('conversation_handles_id_check', sql`${table.id} ~ '^conv_[a-z2-7]{10}$'`),
  ],
);

export type ConversationHandleRow = typeof conversationHandles.$inferSelect;
