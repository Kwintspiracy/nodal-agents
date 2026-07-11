// queries/telegram-allowed.ts — outbound Telegram recipient authorization (F1).
//
// The delivery tools (telegram_send_message / send_image / send_file /
// send_video / send_audio / send_voice) let the caller target an EXPLICIT
// chatId instead of replying to the job's origin chat. Without a check here,
// any agent could push a message/file to any chat id it can guess or was
// told about by an untrusted source (prompt injection). isChatAllowed gates
// that: the target must be an ACTIVE row already approved via the inbound
// H-1 flow (telegram_allowed_chats), scoped to either this agent OR its
// entity — entity-scoped so a DELEGATED worker job, which inherits its
// entity ROOT agent's bot token (B3, ctx.resolvedTelegramBotToken), can
// still target chats that were approved on the root agent.
//
// S2 (migration 0064): thin delegation to the channel-neutral
// isConversationAllowed, pinned to channel='telegram'. That function reads
// telegram_allowed_chats directly for this channel (see
// queries/channel-identity.ts's file header) — same query as before, so this
// wrapper's behavior is byte-identical to the pre-S2 implementation.

import { isConversationAllowed } from './channel-identity.ts';
import type { AnyDrizzleDb } from '../client.ts';

export async function isChatAllowed(
  db: AnyDrizzleDb,
  params: { entityId: string; agentId: string; chatId: string },
): Promise<boolean> {
  return isConversationAllowed(db, {
    entityId: params.entityId,
    agentId: params.agentId,
    channel: 'telegram',
    conversationId: params.chatId,
  });
}
