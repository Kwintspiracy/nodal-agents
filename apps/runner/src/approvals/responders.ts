// approvals/responders.ts — QUI a répondu à une carte, lu dans les données.
//
// `resolved_by` dit par où une réponse est arrivée (api, telegram…), jamais
// qui l'a donnée. Les mots d'une personne remis à la tête du run
// (card-words.ts) disent donc aussi son rôle, tel que la base le garde, et
// l'identité que son canal donne — un membre n'y passe jamais pour le
// propriétaire (revue Reviewer A de #799, passe 1).
//
// Deux sortes de répondants, celles que les chemins de réponse connaissent :
//   - une PERSONNE du dashboard ou de l'API : son compte (`users`) et son
//     rôle dans l'entité de la carte (`entity_members.role`) ;
//   - une CONVERSATION de canal autorisée : celle d'où vient le geste, et son
//     rôle (`telegram_allowed_chats` pour Telegram, `channel_allowed_conversations`
//     pour les autres canaux).
// Aucune ligne qui donne le rôle : `unlisted`, dit tel quel, jamais un rôle
// supposé.
//
// L'identité part chez le fournisseur du modèle avec les mots : elle est
// écrite par `personForModel` (#810) — l'id du compte, l'id de la ligne qui
// autorise la conversation, jamais un e-mail ni l'identifiant du canal.

import { and, eq } from '@nodal-agents/db';
import {
  channelAllowedConversations,
  entityMembers,
  telegramAllowedChats,
  users,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { Responder } from './card-words.ts';
import { personForModel } from '../person-for-model.ts';

/** Celui qui a répondu, tel que le chemin de la réponse le connaît. */
export type AnsweredBy =
  /** Une personne connectée au dashboard, ou une session de l'API. */
  | { readonly userId: string }
  /** La conversation de canal d'où vient le geste, sur le bot qui l'a reçu. */
  | { readonly channel: string; readonly agentId: string; readonly conversationId: string };

/** Le rôle quand aucune ligne ne le donne. */
export const UNLISTED_ROLE = 'unlisted';

export async function readResponder(
  db: AnyDrizzleDb,
  answeredBy: AnsweredBy,
  entityId: string | null,
): Promise<Responder> {
  if ('userId' in answeredBy) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, answeredBy.userId))
      .limit(1);
    const [member] =
      entityId === null
        ? []
        : await db
            .select({ role: entityMembers.role })
            .from(entityMembers)
            .where(
              and(
                eq(entityMembers.entityId, entityId),
                eq(entityMembers.userId, answeredBy.userId),
              ),
            )
            .limit(1);
    return {
      role: member?.role ?? UNLISTED_ROLE,
      identity: personForModel({
        kind: 'account',
        userId: answeredBy.userId,
        found: user !== undefined,
      }),
    };
  }
  const { channel, agentId, conversationId } = answeredBy;
  const [row] =
    channel === 'telegram'
      ? await db
          .select({ id: telegramAllowedChats.id, role: telegramAllowedChats.role })
          .from(telegramAllowedChats)
          .where(
            and(
              eq(telegramAllowedChats.agentId, agentId),
              eq(telegramAllowedChats.chatId, conversationId),
            ),
          )
          .limit(1)
      : await db
          .select({ id: channelAllowedConversations.id, role: channelAllowedConversations.role })
          .from(channelAllowedConversations)
          .where(
            and(
              eq(channelAllowedConversations.agentId, agentId),
              eq(channelAllowedConversations.channel, channel),
              eq(channelAllowedConversations.conversationId, conversationId),
            ),
          )
          .limit(1);
  return {
    role: row?.role ?? UNLISTED_ROLE,
    identity: personForModel({
      kind: 'conversation',
      channel,
      allowedConversationId: row?.id ?? null,
    }),
  };
}
