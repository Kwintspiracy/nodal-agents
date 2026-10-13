// queries/designated-chat.ts — THE way a job row gets a chat (#649).
//
// A `chat_id` does not say which platform it belongs to. Every writer used to
// set it its own way, and only some recorded the channel: the runner then
// guessed it (the agent's first active channel) and sent a Telegram chat id to
// Discord. Review of #657, passes 2 and 3: a chat carries the channel it was
// RESOLVED on, and a writer that does not know it says so (NULL) — it never
// guesses. Every insertion of an `agent_jobs` row that sets `chatId` goes
// through `designateChat` (enforced by designated-chat-writers.test.ts).

import { resolveOwnerConversation } from './channel-identity.ts';
import type { AnyDrizzleDb } from '../client.ts';

/** The two columns a job row carries for its chat, always set together. */
export interface DesignatedChat {
  chatId: string | null;
  /** The channel `chatId` was resolved on; null when nobody knows it. */
  chatChannel: string | null;
}

/**
 * A chat, with the channel it was RESOLVED on: the conversation a request came
 * from (its transport), or THE owner conversation of a given channel. An id
 * that came without a known channel (an explicit `chat_id` on a schedule left
 * on auto, an `/api/agent` call on a non-transport channel, an id an
 * orchestrator passed to a delegate) is designated with `resolvedOn = null`.
 */
export function designateChat(
  chatId: string | null | undefined,
  resolvedOn: string | null,
): DesignatedChat {
  const id = chatId && chatId.trim() !== '' ? chatId : null;
  return { chatId: id, chatChannel: id ? resolvedOn : null };
}

/**
 * The chat a routine's confirmation goes to — ONE rule for the cron tick,
 * "Run now" and the `run_schedule` tool, which each resolved it their own way.
 *
 * - `notify_on_success` off: no chat, the routine runs silently.
 * - a notify channel chosen: the schedule's explicit chat on that channel, or
 *   the owner conversation of that channel;
 * - auto: an explicit chat is designated with no channel (nothing says its
 *   platform); otherwise the owner's Telegram chat — `auto` has always
 *   resolved the Telegram owner, and it is that resolution that knows the
 *   channel.
 */
export async function resolveScheduleNotifyChat(
  db: AnyDrizzleDb,
  schedule: {
    agentId: string;
    notifyOnSuccess: boolean | null;
    notifyChannel: string | null;
    chatId: string | null;
  },
): Promise<DesignatedChat> {
  if (!schedule.notifyOnSuccess) return designateChat(null, null);
  if (schedule.notifyChannel) {
    const chatId =
      schedule.chatId ??
      (await resolveOwnerConversation(db, schedule.agentId, schedule.notifyChannel));
    return designateChat(chatId, schedule.notifyChannel);
  }
  if (schedule.chatId) return designateChat(schedule.chatId, null);
  return designateChat(
    await resolveOwnerConversation(db, schedule.agentId, 'telegram'),
    'telegram',
  );
}
