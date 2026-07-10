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

import { eq, and, or } from 'drizzle-orm';
import { telegramAllowedChats } from '../schema/telegram-allowed-chats.ts';
import type { AnyDrizzleDb } from '../client.ts';

export async function isChatAllowed(
  db: AnyDrizzleDb,
  params: { entityId: string; agentId: string; chatId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: telegramAllowedChats.id })
    .from(telegramAllowedChats)
    .where(
      and(
        eq(telegramAllowedChats.chatId, params.chatId),
        eq(telegramAllowedChats.status, 'active'),
        or(
          eq(telegramAllowedChats.entityId, params.entityId),
          eq(telegramAllowedChats.agentId, params.agentId),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}
