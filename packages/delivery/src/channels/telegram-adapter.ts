// channels/telegram-adapter.ts — ChannelAdapter implementation for Telegram.
//
// Pure delegation: every method here forwards to the existing, untouched
// functions in `channels/telegram.ts` (chunking, retry/backoff, redaction,
// file-size caps — none of that is reimplemented). This file only adapts the
// channel-neutral shape (ChannelAdapter) onto Telegram's existing wire
// contract, so nothing about today's behavior changes.

import { DeliveryError } from '../errors.ts';
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramDocument,
  sendTelegramVideo,
  sendTelegramAudio,
  sendTelegramVoice,
  getTelegramBotInfo,
  editTelegramMessageText,
  type TelegramInlineKeyboard,
  type TelegramSendOpts,
} from './telegram.ts';
import type {
  ChannelAdapter,
  ChannelCredentials,
  OutboundMedia,
  ApprovalCard,
  QuestionCard,
  SendResult,
  BotIdentity,
  TextFormat,
} from '../channel-adapter.ts';

function requireBotToken(creds: ChannelCredentials): string {
  const botToken = creds['botToken'];
  if (!botToken) {
    throw new DeliveryError('telegram_no_token', 'telegram_no_token: missing botToken credential');
  }
  return botToken;
}

function requireChatId(conversationId: string): string {
  if (!conversationId) {
    throw new DeliveryError('telegram_no_chat_id', 'telegram_no_chat_id: missing conversationId');
  }
  return conversationId;
}

/** Channel-neutral format hint → Telegram's own parse_mode values. */
function toParseMode(format: TextFormat | undefined): TelegramSendOpts['parseMode'] {
  switch (format) {
    case 'markdown':
      return 'MarkdownV2';
    case 'html':
      return 'HTML';
    case 'plain':
    case undefined:
      return undefined;
    default: {
      // Exhaustiveness guard — a new TextFormat member must be handled above.
      const _exhaustive: never = format;
      throw new DeliveryError('send_failed', `send_failed: unknown text format "${_exhaustive}"`);
    }
  }
}

async function sendText(
  creds: ChannelCredentials,
  conversationId: string,
  text: string,
  opts?: { format?: TextFormat },
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const chatId = requireChatId(conversationId);
  const { messageId } = await sendTelegramMessage({
    chatId,
    botToken,
    text,
    parseMode: toParseMode(opts?.format),
  });
  return { messageId: String(messageId) };
}

async function sendMedia(
  creds: ChannelCredentials,
  conversationId: string,
  media: OutboundMedia,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const chatId = requireChatId(conversationId);
  const { kind, bytes, filename, caption } = media;

  let result: { messageId: number };
  switch (kind) {
    case 'photo':
      result = await sendTelegramPhoto({ chatId, botToken, photo: bytes, filename, caption });
      break;
    case 'document':
      result = await sendTelegramDocument({ chatId, botToken, document: bytes, filename, caption });
      break;
    case 'video':
      result = await sendTelegramVideo({ chatId, botToken, bytes, filename, caption });
      break;
    case 'audio':
      result = await sendTelegramAudio({ chatId, botToken, bytes, filename, caption });
      break;
    case 'voice':
      result = await sendTelegramVoice({ chatId, botToken, bytes, filename, caption });
      break;
    default: {
      // Exhaustiveness guard — a new OutboundMedia.kind must be handled above.
      const _exhaustive: never = kind;
      throw new DeliveryError('send_failed', `send_failed: unknown media kind "${_exhaustive}"`);
    }
  }
  return { messageId: String(result.messageId) };
}

/**
 * ApprovalCard → Telegram's existing inline-keyboard shape. `callbackId` is
 * carried verbatim (the caller — approvals/notify.ts — already builds it as
 * `apr:<approvalRequestId>`); this just appends the `:a`/`:r` suffix that
 * approval-callback.ts's `parseApprovalCallbackData` expects, matching the
 * EXACT wire format already in use today.
 */
async function sendApprovalCard(
  creds: ChannelCredentials,
  conversationId: string,
  card: ApprovalCard,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const chatId = requireChatId(conversationId);
  const inlineKeyboard: TelegramInlineKeyboard = [
    [
      { text: card.approveLabel, callback_data: `${card.callbackId}:a` },
      { text: card.rejectLabel, callback_data: `${card.callbackId}:r` },
    ],
  ];
  // « Toujours autoriser » sur sa PROPRE ligne, pleine largeur : trois tiers
  // sur une ligne tronquent les libellés sur mobile.
  if (card.alwaysLabel) {
    inlineKeyboard.push([{ text: card.alwaysLabel, callback_data: `${card.callbackId}:w` }]);
  }
  const { messageId } = await sendTelegramMessage({
    chatId,
    botToken,
    text: card.text,
    inlineKeyboard,
  });
  return { messageId: String(messageId) };
}

/**
 * QuestionCard → un inline keyboard d'UNE option par LIGNE (P10a). Une ligne
 * chacune, pas deux par rangée : un libellé d'option peut faire soixante
 * caractères, et Telegram les tronque au milieu du mot sur mobile dès qu'ils
 * partagent une rangée.
 */
async function sendQuestionCard(
  creds: ChannelCredentials,
  conversationId: string,
  card: QuestionCard,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const chatId = requireChatId(conversationId);
  const inlineKeyboard: TelegramInlineKeyboard = card.options.map((label, i) => [
    { text: label, callback_data: `${card.callbackId}:o${i}` },
  ]);
  const { messageId } = await sendTelegramMessage({
    chatId,
    botToken,
    text: card.text,
    inlineKeyboard,
  });
  return { messageId: String(messageId) };
}

async function editMessageText(
  creds: ChannelCredentials,
  conversationId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const botToken = requireBotToken(creds);
  const chatId = requireChatId(conversationId);
  await editTelegramMessageText({ botToken, chatId, messageId: Number(messageId), text });
}

async function validateCredentials(creds: ChannelCredentials): Promise<BotIdentity> {
  const botToken = requireBotToken(creds);
  const info = await getTelegramBotInfo(botToken);
  return {
    id: String(info.id),
    username: info.username || null,
    displayName: info.firstName || null,
  };
}

export const telegramAdapter: ChannelAdapter = {
  channel: 'telegram',
  capabilities: { buttons: true, threads: false, media: true, editMessage: true },
  sendText,
  sendMedia,
  sendApprovalCard,
  sendQuestionCard,
  editMessageText,
  // listConversations: intentionally NOT implemented — the Bot API has no enumeration whatsoever (no "list my chats" endpoint); callers fall back to the allowlist.
  validateCredentials,
};
