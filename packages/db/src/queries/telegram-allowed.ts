// queries/telegram-allowed.ts — outbound Telegram recipient authorization (F1).
//
// The delivery tools (telegram_send_message / send_image / send_file /
// send_video / send_audio / send_voice) let the caller target an EXPLICIT
// chatId instead of replying to the job's origin chat. Without a check here,
// any agent could push a message/file to any chat id it can guess or was
// told about by an untrusted source (prompt injection). isChatAllowed gates
// that: the target must be an ACTIVE row already approved via the inbound
// H-1 flow (telegram_allowed_chats), scoped to either this agent OR its
// entity — entity-scoped so an agent with its own bot token can target chats
// that were approved on another agent of the same entity (e.g. the root).
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
