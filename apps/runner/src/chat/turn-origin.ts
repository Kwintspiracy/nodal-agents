// chat/turn-origin.ts — where a chat or voice turn was made, read on its conversation (#945).
//
// L'ORIGINE EST UNE DONNÉE (règle du #948). A turn belongs to the
// conversation it names, and that conversation says where it lives: the
// dashboard's own thread, or a device's (`conversations.channel = 'device'`,
// `chat_id` = the device). The job a turn launches records that origin —
// `channel`, and the device as its chat (`designateChat`) — and every reader
// that sends something back (questions, approvals, previews, the spoken
// announcement) follows it, as it follows a Telegram chat. There is no branch
// "is this the dashboard" in the turn: the conversation answers.
//
// Only a conversation whose turns are kept in `chat_messages` is a chat turn's
// (`keepsTurnsInChat`). A Telegram, Slack, Discord or WhatsApp thread has its
// turns as head jobs, made on the platform: a chat turn written into one
// would record a message the platform never carried. It is refused by name.

import { designateChat, type DesignatedChat } from '@nodal-agents/db';
import { keepsTurnsInChat, type ChatStoreChannel } from '@nodal-agents/shared';

export interface ChatTurnOrigin {
  /** `agent_jobs.channel` of the job the turn launches. */
  channel: ChatStoreChannel;
  /** Its chat: none for the dashboard, the device for a device. */
  chat: DesignatedChat;
}

/** The origin of a turn made in this conversation, or null: not a chat conversation. */
export function chatTurnOrigin(conv: {
  channel: string;
  chatId: string | null;
}): ChatTurnOrigin | null {
  const channel = conv.channel;
  if (!keepsTurnsInChat(channel)) return null;
  switch (channel) {
    case 'dashboard':
      return { channel, chat: designateChat(null, null) };
    case 'device':
      // A device conversation without its device names nowhere to answer.
      if (!conv.chatId) return null;
      return { channel, chat: designateChat(conv.chatId, 'device') };
    default: {
      const unhandled: never = channel;
      throw new Error(`chat_turn_origin_unhandled: ${String(unhandled)}`);
    }
  }
}
