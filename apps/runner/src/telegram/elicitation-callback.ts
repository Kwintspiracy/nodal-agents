// telegram/elicitation-callback.ts — la forme Telegram des deux gestes qui
// remplissent la question d'un serveur MCP depuis la conversation (0145) : un
// appui sur un bouton de la carte (`eli:<id>:<op>`), et un message tapé EN
// RÉPONSE à la carte. Tout le fond vit dans approvals/elicitation-channel.ts,
// partagé avec Discord et Slack ; ici, seulement d'où vient l'événement et
// comment Telegram affiche l'avis (la bulle du bouton).

import { answerTelegramCallback, type TelegramUpdate } from '@nodal-agents/delivery';
import { parseElicitationCallbackData } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import {
  handleElicitationTap,
  handleElicitationReply,
  type ElicitationInteractionResult,
} from '../approvals/elicitation-channel.ts';

/** Un appui sur un bouton d'une carte d'élicitation ; null quand le bouton n'en est pas un. */
export async function handleTelegramElicitationCallback(args: {
  update: TelegramUpdate;
  receivingAgentId: string;
  botToken: string;
  deps: RunnerDeps;
  env: RunnerEnv;
}): Promise<ElicitationInteractionResult | null> {
  const cb = args.update.callback_query;
  if (!cb || !parseElicitationCallbackData(cb.data)) return null;
  const chatId = cb.message?.chat?.id;
  if (chatId === undefined) {
    await answerTelegramCallback(args.botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'no_chat', notice: 'Not authorized.' };
  }
  const result = await handleElicitationTap({
    deps: args.deps,
    env: args.env,
    origin: {
      channel: 'telegram',
      receivingAgentId: args.receivingAgentId,
      conversationId: String(chatId),
    },
    data: cb.data!,
  });
  // Un refus s'affiche en alerte (il faut le lire) ; un avis ordinaire en bulle.
  await answerTelegramCallback(args.botToken, cb.id, result.notice ?? undefined, !result.handled);
  return result;
}

/**
 * Un message tapé en réponse à un message du bot. Rend le résultat quand ce
 * message était une carte d'élicitation ouverte ; null sinon — le message suit
 * alors son chemin habituel.
 */
export async function handleTelegramElicitationReply(args: {
  update: TelegramUpdate;
  receivingAgentId: string;
  deps: RunnerDeps;
}): Promise<ElicitationInteractionResult | null> {
  const message = args.update.message;
  const replyTo = message?.reply_to_message?.message_id;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (replyTo === undefined || chatId === undefined || !text) return null;
  const result = await handleElicitationReply({
    deps: args.deps,
    origin: {
      channel: 'telegram',
      receivingAgentId: args.receivingAgentId,
      conversationId: String(chatId),
    },
    replyToMessageId: String(replyTo),
    text,
  });
  return result.handled ? result : null;
}
