// telegram/auth-callback.ts — resolve an inbound-chat authorization from an
// inline-button tap (H-1).
//
// When an unknown chat DMs a bot that already has an owner, the owner receives a
// card: "👤 <name> wants to talk to this bot. Allow?" with [✅ Allow] [❌ Deny].
// Only the OWNER may tap it. Allow → the pending row goes active (that chat can
// now create jobs); Deny → the row is deleted (the chat stays blocked, and a
// future message re-asks).

import { eq, and } from '@nodal-agents/db';
import { telegramAllowedChats, channelAllowedConversations } from '@nodal-agents/db';
import {
  answerTelegramCallback,
  editTelegramMessageText,
  type TelegramUpdate,
} from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';

/** Inline-button callback_data prefix for chat-authorization decisions. */
export const TELEGRAM_AUTH_CALLBACK_PREFIX = 'tgauth';

export interface HandleAuthCallbackArgs {
  update: TelegramUpdate;
  /** The polling agent — the authorization row must belong to its bot. */
  receivingAgentId: string;
  botToken: string;
  deps: RunnerDeps;
}

export type AuthCallbackResult =
  | { handled: true; decision: 'allow' | 'deny'; chatId: string }
  | { handled: false; reason: string };

/** Parse `tgauth:<uuid>:<a|d>` → { allowedChatId, decision }, or null. */
export function parseAuthCallbackData(
  data: string | undefined,
): { allowedChatId: string; decision: 'allow' | 'deny' } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== TELEGRAM_AUTH_CALLBACK_PREFIX) return null;
  const [, id, d] = parts;
  if (!id || (d !== 'a' && d !== 'd')) return null;
  return { allowedChatId: id, decision: d === 'a' ? 'allow' : 'deny' };
}

/** Inline keyboard for the owner's allow/deny card. */
export function buildAuthConfirmKeyboard(
  allowedChatId: string,
): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      {
        text: '✅ Autoriser',
        callback_data: `${TELEGRAM_AUTH_CALLBACK_PREFIX}:${allowedChatId}:a`,
      },
      { text: '❌ Refuser', callback_data: `${TELEGRAM_AUTH_CALLBACK_PREFIX}:${allowedChatId}:d` },
    ],
  ];
}

export async function handleAuthCallback(
  args: HandleAuthCallbackArgs,
): Promise<AuthCallbackResult> {
  const { update, receivingAgentId, botToken, deps } = args;
  const cb = update.callback_query;
  if (!cb) return { handled: false, reason: 'no_callback_query' };

  const parsed = parseAuthCallbackData(cb.data);
  if (!parsed) {
    await answerTelegramCallback(botToken, cb.id);
    return { handled: false, reason: 'not_an_auth_callback' };
  }

  // Authorization decisions are DM-only — mirrors the approval-callback rule: a
  // group has many members who could tap the button; only the owner's private
  // chat with the bot may decide.
  if (cb.message?.chat?.type !== 'private') {
    await answerTelegramCallback(
      botToken,
      cb.id,
      'This can only be decided in a private chat with the bot.',
      true,
    );
    return { handled: false, reason: 'not_private_chat' };
  }

  const tappedChatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;

  // Load the pending row.
  const [row] = await deps.db
    .select({
      id: telegramAllowedChats.id,
      agentId: telegramAllowedChats.agentId,
      chatId: telegramAllowedChats.chatId,
      status: telegramAllowedChats.status,
      requesterName: telegramAllowedChats.requesterName,
    })
    .from(telegramAllowedChats)
    .where(eq(telegramAllowedChats.id, parsed.allowedChatId))
    .limit(1);

  if (!row) {
    await answerTelegramCallback(botToken, cb.id, 'This request no longer exists.', true);
    return { handled: false, reason: 'auth_row_not_found' };
  }

  // Defense in depth: the tap must arrive on the bot that owns this row.
  if (row.agentId !== receivingAgentId) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'agent_mismatch' };
  }

  // SECURITY: only the bot's OWNER may decide. Verify the tap came from the
  // owner's chat.
  const [owner] = await deps.db
    .select({ chatId: telegramAllowedChats.chatId })
    .from(telegramAllowedChats)
    .where(
      and(
        eq(telegramAllowedChats.agentId, receivingAgentId),
        eq(telegramAllowedChats.role, 'owner'),
        eq(telegramAllowedChats.status, 'active'),
      ),
    )
    .limit(1);

  if (!owner || tappedChatId === undefined || String(tappedChatId) !== owner.chatId) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'not_owner' };
  }

  // Already decided (the row went active, or was denied+deleted and this is a
  // stale tap) — the not-found case above covers deletion; here we catch a
  // double-allow.
  if (row.status === 'active') {
    await answerTelegramCallback(botToken, cb.id, 'Already allowed.');
    if (messageId !== undefined) {
      await editTelegramMessageText({
        botToken,
        chatId: owner.chatId,
        messageId,
        text: `✅ ${row.requesterName ?? 'Ce contact'} est déjà autorisé.`,
      }).catch(() => {});
    }
    return { handled: true, decision: 'allow', chatId: row.chatId };
  }

  const who = row.requesterName ?? 'Ce contact';
  if (parsed.decision === 'allow') {
    // Conditional on still-pending so a concurrent decision can't be clobbered.
    await deps.db
      .update(telegramAllowedChats)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(telegramAllowedChats.id, row.id), eq(telegramAllowedChats.status, 'pending')));
    // S3 dual-write: mirror the allow decision. Correlated by
    // (agent, channel, conversationId) rather than a shared id — the two
    // tables' rows are inserted independently (handler.ts's dual-write) and
    // never share a primary key.
    await deps.db
      .update(channelAllowedConversations)
      .set({ status: 'active', updatedAt: new Date() })
      .where(
        and(
          eq(channelAllowedConversations.agentId, row.agentId),
          eq(channelAllowedConversations.channel, 'telegram'),
          eq(channelAllowedConversations.conversationId, row.chatId),
        ),
      );
    await answerTelegramCallback(botToken, cb.id, '✅ Autorisé');
    if (messageId !== undefined) {
      await editTelegramMessageText({
        botToken,
        chatId: owner.chatId,
        messageId,
        text: `✅ ${who} est maintenant autorisé à parler à ce bot.`,
      }).catch(() => {});
    }
    return { handled: true, decision: 'allow', chatId: row.chatId };
  }

  // Deny: remove the row so the chat stays blocked (a future message re-asks).
  await deps.db.delete(telegramAllowedChats).where(eq(telegramAllowedChats.id, row.id));
  // S3 dual-write: mirror the deletion — same correlation as the allow path.
  await deps.db
    .delete(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.agentId, row.agentId),
        eq(channelAllowedConversations.channel, 'telegram'),
        eq(channelAllowedConversations.conversationId, row.chatId),
      ),
    );
  await answerTelegramCallback(botToken, cb.id, '❌ Refusé');
  if (messageId !== undefined) {
    await editTelegramMessageText({
      botToken,
      chatId: owner.chatId,
      messageId,
      text: `❌ ${who} n'est pas autorisé à parler à ce bot.`,
    }).catch(() => {});
  }
  return { handled: true, decision: 'deny', chatId: row.chatId };
}
