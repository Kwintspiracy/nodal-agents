// queries/telegram-owner.ts — resolve a bot's OWNER Telegram chat.
//
// Delivery rule (2026-07-09): unsolicited/authoritative pushes to a human —
// a cron's success report, a dashboard "send result via Telegram", an
// agent-run schedule — must reach the person concerned in a 1:1, defaulting
// to the bot OWNER. Historically these read `agents.last_seen_chat_id_telegram`
// ("the last chat this agent was spoken to in"), which a GROUP message
// silently overwrites — so a cron summary leaked into a group the moment
// anyone @-mentioned the agent there. The owner is the deterministic,
// correct target: ownership can only be claimed from a private DM (see the
// Telegram handler), so an owner always has a reachable 1:1 chat.
//
// A schedule may still carry an EXPLICIT `chat_id` target (e.g. "post the
// standup to #team") — callers resolve `schedule.chatId ?? resolveOwnerChatId()`
// so an intentional target wins and the owner is the safe default, never a
// polluted last-seen value.

import { eq, and } from 'drizzle-orm';
import { telegramAllowedChats } from '../schema/telegram-allowed-chats.ts';
import type { AnyDrizzleDb } from '../client.ts';

/**
 * The active OWNER's Telegram chat id for a given bot (the RECEIVING agent),
 * or null when the agent has no registered owner. One row per (agent_id,
 * chat_id); the owner row is unique per agent.
 */
export async function resolveOwnerChatId(
  db: AnyDrizzleDb,
  agentId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ chatId: telegramAllowedChats.chatId })
    .from(telegramAllowedChats)
    .where(
      and(
        eq(telegramAllowedChats.agentId, agentId),
        eq(telegramAllowedChats.role, 'owner'),
        eq(telegramAllowedChats.status, 'active'),
      ),
    )
    .limit(1);
  return row?.chatId ?? null;
}
