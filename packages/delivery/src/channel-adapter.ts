// channel-adapter.ts — channel-neutral send surface (S1 of the multichannel plan).
//
// WHY this exists: every send-side caller today (approvals/notify.ts, the
// telegram_send_message tool, cron delivery, …) talks to `channels/telegram.ts`
// directly, so adding Discord/Slack/WhatsApp later would mean re-deriving the
// same wiring per channel. `ChannelAdapter` is the seam: ONE interface each
// channel implements, resolved via `getAdapter()` (registry.ts) instead of a
// hardcoded import. This file only defines the shape — the Telegram side keeps
// working exactly as before via `channels/telegram-adapter.ts`, which delegates
// to the existing, untouched `channels/telegram.ts` functions.
//
// The surface is intentionally minimal: only what today's callers need
// (send text, send media, send/resolve an approval card, edit a message,
// validate a bot's credentials). Extending it for a channel-specific feature
// happens when a real caller needs it, not speculatively.

/** Messaging platforms Nodal can deliver through. Extensible — add a kind here
 *  + a registry entry when its adapter ships; nothing else changes shape. */
export type ChannelKind = 'telegram' | 'discord' | 'slack' | 'whatsapp';

/**
 * Per-channel credential bag, jsonb-shaped (string values only — matches how
 * these are stored/read from the DB). Telegram's shape is `{ botToken }`.
 */
export type ChannelCredentials = Record<string, string>;

/** Plain-text formatting hint, channel-neutral. Each adapter maps this to its
 *  own wire format (Telegram: undefined/'MarkdownV2'/'HTML'). */
export type TextFormat = 'plain' | 'markdown' | 'html';

export interface SendTextOpts {
  format?: TextFormat;
}

/** A file to deliver as chat media. `kind` picks the platform's native
 *  presentation (e.g. Telegram sendPhoto vs sendDocument vs sendVoice). */
export interface OutboundMedia {
  kind: 'photo' | 'document' | 'video' | 'audio' | 'voice';
  bytes: Uint8Array;
  filename: string;
  caption?: string;
}

/**
 * Neutral content for an approve/reject card. Each adapter renders its own
 * native buttons; `callbackId` is opaque to the adapter — it round-trips
 * through the platform's interaction payload (Telegram: encoded into each
 * button's `callback_data`) so the caller can recognize which card a tap
 * belongs to without the adapter knowing anything about approvals.
 */
export interface ApprovalCard {
  text: string;
  approveLabel: string;
  rejectLabel: string;
  /**
   * Optional third action: « toujours autoriser » (writes a standing
   * auto-approve rule after an in-channel confirmation step). Suffixed `:w`
   * on the callbackId. Adapters that don't render it (Discord/Slack today —
   * the confirm-by-message-edit flow is Telegram-only for now) simply keep
   * their two buttons; absent = the exact pre-existing card.
   */
  alwaysLabel?: string;
  callbackId: string;
}

export interface SendResult {
  messageId: string;
}

/** Result of validating a channel's credentials (Telegram: getMe). */
export interface BotIdentity {
  id: string;
  username: string | null;
  displayName: string | null;
}

export interface ChannelCapabilities {
  /** Can render an interactive approve/reject card (sendApprovalCard is implemented). */
  buttons: boolean;
  /** Has a native concept of threads/topics within a conversation. */
  threads: boolean;
  /** Can deliver binary attachments (sendMedia is implemented). */
  media: boolean;
  /** Can rewrite a previously-sent message's text (editMessageText is implemented). */
  editMessage: boolean;
}

/** One conversation a bot/session can send into, as surfaced by a channel's
 *  own enumeration API (Discord: guild channels, Slack: users.conversations,
 *  WhatsApp: participating groups). Neutral shape — each adapter maps its own
 *  wire objects onto this, the same way OutboundMedia/ApprovalCard are the
 *  neutral shapes for sending. */
export type DiscoveredConversation = {
  conversationId: string;
  name: string;
  kind: 'private' | 'group' | 'channel' | 'thread';
  /** Grouping container when the platform has one (Discord guild name, Slack workspace) */
  groupName?: string;
};

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  readonly capabilities: ChannelCapabilities;

  sendText(
    creds: ChannelCredentials,
    conversationId: string,
    text: string,
    opts?: SendTextOpts,
  ): Promise<SendResult>;

  sendMedia(
    creds: ChannelCredentials,
    conversationId: string,
    media: OutboundMedia,
  ): Promise<SendResult>;

  /** Optional: only channels with `capabilities.buttons` implement this. */
  sendApprovalCard?(
    creds: ChannelCredentials,
    conversationId: string,
    card: ApprovalCard,
  ): Promise<SendResult>;

  /** Optional: only channels with `capabilities.editMessage` implement this. */
  editMessageText?(
    creds: ChannelCredentials,
    conversationId: string,
    messageId: string,
    text: string,
  ): Promise<void>;

  /** Optional: only channels whose platform can enumerate what a bot/session
   *  could send into implement this (Telegram's Bot API has no such
   *  enumeration at all — see telegram-adapter.ts). */
  listConversations?(creds: ChannelCredentials): Promise<DiscoveredConversation[]>;

  validateCredentials(creds: ChannelCredentials): Promise<BotIdentity>;
}
