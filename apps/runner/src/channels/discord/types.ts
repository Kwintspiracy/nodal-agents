// channels/discord/types.ts — neutral shapes discord/handler.ts and
// discord/interactions.ts operate on. gateway.ts adapts LIVE discord.js
// Message/Interaction objects into these before calling into the handler
// logic below — mirrors how telegram/handler.ts operates on the already-JSON
// TelegramUpdate shape, keeping the state-machine logic testable against
// plain objects without ever needing to construct a live discord.js class
// instance (Message, Interaction, ...) inside a unit test.

export interface DiscordInboundAttachment {
  url: string;
  contentType: string | null;
  size: number;
  name: string;
}

export interface DiscordInboundMessage {
  /** The channel (DM or guild text channel) this message was sent in — the conversation id. */
  channelId: string;
  channelType: 'dm' | 'guild_text';
  content: string;
  author: { id: string; bot: boolean; username: string; globalName: string | null };
  /** User ids @mentioned in this message's content. */
  mentionedUserIds: string[];
  /** Set when this message is a reply, to the AUTHOR id of the message it replies to. */
  referencedMessageAuthorId?: string;
  attachments: DiscordInboundAttachment[];
}

export interface DiscordInteractionAck {
  /**
   * Ephemeral reply visible only to the tapper — does NOT touch the original
   * card message. Used for security-gate denials and "already resolved" info,
   * mirroring telegram/approval-callback.ts's `answerTelegramCallback(...,
   * showAlert=true)` popup.
   */
  ephemeralReply(text: string): Promise<void>;
  /**
   * Acknowledge the tap AND rewrite the card message to the resolved state
   * (buttons stripped) — one Discord API call, mirroring telegram's
   * `answerTelegramCallback` + `editTelegramMessageText` pair.
   */
  resolveCard(text: string): Promise<void>;
}
