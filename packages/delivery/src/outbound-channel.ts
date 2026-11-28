// outbound-channel.ts — what a messaging channel posts leaves through the seam.
//
// Every text this package can post on a platform — a channel adapter's text,
// card, caption and edit, the Telegram Bot API calls the runner makes directly
// (auth cards, notices, callback toasts), a WhatsApp socket's `send` — is
// masked here, by the outbound functions of `@nodal-agents/shared`, before the
// adapter formats or cuts it (the adapters chunk a long text: masked first, a
// value straddling a chunk boundary leaves nothing of itself).
//
// This module is the ONLY one, outside `channels/`, that reaches a channel
// module by value: the registry resolves its adapters from here, and the
// package index exports the senders from here. The architecture suite of this
// package refuses a value import of `channels/` anywhere else
// (`scanForOutboundBypass`), so a sender cannot be published beside the seam.
//
// What is NOT masked: identifiers the platform routes by (a callback id, a
// button's callback data, a chat id), the bytes of a file, and the answer a
// choice sends back (it is a decision, read by the runner, never shown).

import { outboundText } from '@nodal-agents/shared';
import type {
  ApprovalCard,
  ButtonCard,
  CardButton,
  ChannelAdapter,
  ChoiceCard,
  QuestionCard,
} from './channel-adapter.ts';
import {
  addTelegramBotCommands as rawAddTelegramBotCommands,
  answerTelegramCallback as rawAnswerTelegramCallback,
  editTelegramMessageText as rawEditTelegramMessageText,
  sendTelegramAudio as rawSendTelegramAudio,
  sendTelegramDocument as rawSendTelegramDocument,
  sendTelegramMessage as rawSendTelegramMessage,
  sendTelegramPhoto as rawSendTelegramPhoto,
  sendTelegramVideo as rawSendTelegramVideo,
  sendTelegramVoice as rawSendTelegramVoice,
  type TelegramBotCommand,
  type TelegramInlineKeyboard,
} from './channels/telegram.ts';
import { telegramAdapter as rawTelegramAdapter } from './channels/telegram-adapter.ts';
import { discordAdapter as rawDiscordAdapter } from './channels/discord-adapter.ts';
import { slackAdapter as rawSlackAdapter } from './channels/slack-adapter.ts';
import { whatsappAdapter as rawWhatsappAdapter } from './channels/whatsapp-adapter.ts';
import { deviceAdapter as rawDeviceAdapter } from './channels/device-adapter.ts';
import { sendEmail as rawSendEmail, type EmailSendOpts } from './channels/email.ts';
import { sendLog as rawSendLog, type LogSendOpts } from './channels/log.ts';
import {
  ensureWhatsAppSocket as rawEnsureWhatsAppSocket,
  type WhatsAppHandle,
} from './channels/whatsapp/socket-manager.ts';

// Reads and connection management: nothing a person reads is posted by these.
export {
  getTelegramBotInfo,
  getTelegramUpdates,
  getTelegramFile,
  TELEGRAM_MAX_FILE_BYTES,
  setTelegramMessageReaction,
} from './channels/telegram.ts';
export { bindDeviceSink } from './channels/device-adapter.ts';
export { closeWhatsAppSocket } from './channels/whatsapp/socket-manager.ts';

const maskButtons = (
  rows: readonly (readonly CardButton[])[] | undefined,
): readonly (readonly CardButton[])[] | undefined =>
  rows?.map((row) => row.map((b) => ({ ...b, label: outboundText(b.label) })));

const maskKeyboard = (kb: TelegramInlineKeyboard | undefined): TelegramInlineKeyboard | undefined =>
  kb?.map((row) => row.map((b) => ({ ...b, text: outboundText(b.text) })));

/**
 * The adapter, every text it posts masked. The capabilities and the text
 * declaration are the adapter's own; only what it posts changes.
 */
export function outboundAdapter(adapter: ChannelAdapter): ChannelAdapter {
  const { sendApprovalCard, sendQuestionCard, sendCard, sendChoiceCard, editMessageText } = adapter;
  return {
    channel: adapter.channel,
    capabilities: adapter.capabilities,
    text: adapter.text,
    sendText: (creds, conversationId, text, opts) =>
      adapter.sendText(creds, conversationId, outboundText(text), opts),
    sendMedia: (creds, conversationId, media) =>
      adapter.sendMedia(creds, conversationId, {
        ...media,
        ...(media.caption !== undefined ? { caption: outboundText(media.caption) } : {}),
      }),
    validateCredentials: (creds) => adapter.validateCredentials(creds),
    ...(adapter.listConversations
      ? { listConversations: adapter.listConversations.bind(adapter) }
      : {}),
    ...(sendApprovalCard
      ? {
          sendApprovalCard: (creds, conversationId, card: ApprovalCard) =>
            sendApprovalCard.call(adapter, creds, conversationId, {
              ...card,
              text: outboundText(card.text),
              approveLabel: outboundText(card.approveLabel),
              rejectLabel: outboundText(card.rejectLabel),
              ...(card.alwaysLabel !== undefined
                ? { alwaysLabel: outboundText(card.alwaysLabel) }
                : {}),
            }),
        }
      : {}),
    ...(sendQuestionCard
      ? {
          sendQuestionCard: (creds, conversationId, card: QuestionCard) =>
            sendQuestionCard.call(adapter, creds, conversationId, {
              ...card,
              text: outboundText(card.text),
              options: card.options.map((o) => outboundText(o)),
            }),
        }
      : {}),
    ...(sendCard
      ? {
          sendCard: (creds, conversationId, card: ButtonCard) =>
            sendCard.call(adapter, creds, conversationId, {
              text: outboundText(card.text),
              buttons: maskButtons(card.buttons) ?? [],
            }),
        }
      : {}),
    ...(sendChoiceCard
      ? {
          sendChoiceCard: (creds, conversationId, card: ChoiceCard) =>
            sendChoiceCard.call(adapter, creds, conversationId, {
              ...card,
              text: outboundText(card.text),
              choices: card.choices.map((c) => ({ ...c, label: outboundText(c.label) })),
              images: card.images.map((i) => ({ ...i, caption: outboundText(i.caption) })),
            }),
        }
      : {}),
    ...(editMessageText
      ? {
          editMessageText: (creds, conversationId, messageId, text, buttons) =>
            editMessageText.call(
              adapter,
              creds,
              conversationId,
              messageId,
              outboundText(text),
              maskButtons(buttons),
            ),
        }
      : {}),
  };
}

export const telegramAdapter: ChannelAdapter = outboundAdapter(rawTelegramAdapter);
export const discordAdapter: ChannelAdapter = outboundAdapter(rawDiscordAdapter);
export const slackAdapter: ChannelAdapter = outboundAdapter(rawSlackAdapter);
export const whatsappAdapter: ChannelAdapter = outboundAdapter(rawWhatsappAdapter);
export const deviceAdapter: ChannelAdapter = outboundAdapter(rawDeviceAdapter);

type Opts<F extends (...args: never[]) => unknown> = Parameters<F>[0];

export function sendTelegramMessage(
  opts: Opts<typeof rawSendTelegramMessage>,
): ReturnType<typeof rawSendTelegramMessage> {
  const inlineKeyboard = maskKeyboard(opts.inlineKeyboard);
  return rawSendTelegramMessage({
    ...opts,
    text: outboundText(opts.text),
    ...(inlineKeyboard ? { inlineKeyboard } : {}),
  });
}

export function editTelegramMessageText(
  opts: Opts<typeof rawEditTelegramMessageText>,
): ReturnType<typeof rawEditTelegramMessageText> {
  const inlineKeyboard = maskKeyboard(opts.inlineKeyboard);
  return rawEditTelegramMessageText({
    ...opts,
    text: outboundText(opts.text),
    ...(inlineKeyboard ? { inlineKeyboard } : {}),
  });
}

export function answerTelegramCallback(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  return rawAnswerTelegramCallback(
    botToken,
    callbackQueryId,
    text === undefined ? undefined : outboundText(text),
    showAlert,
  );
}

export function addTelegramBotCommands(
  botToken: string,
  commands: readonly TelegramBotCommand[],
): Promise<string[]> {
  return rawAddTelegramBotCommands(
    botToken,
    commands.map((c) => ({ ...c, description: outboundText(c.description) })),
  );
}

const withCaption = <T extends { caption?: string }>(opts: T): T =>
  opts.caption === undefined ? opts : { ...opts, caption: outboundText(opts.caption) };

export const sendTelegramPhoto = (
  opts: Opts<typeof rawSendTelegramPhoto>,
): ReturnType<typeof rawSendTelegramPhoto> => rawSendTelegramPhoto(withCaption(opts));
export const sendTelegramDocument = (
  opts: Opts<typeof rawSendTelegramDocument>,
): ReturnType<typeof rawSendTelegramDocument> => rawSendTelegramDocument(withCaption(opts));
export const sendTelegramVideo = (
  opts: Opts<typeof rawSendTelegramVideo>,
): ReturnType<typeof rawSendTelegramVideo> => rawSendTelegramVideo(withCaption(opts));
export const sendTelegramAudio = (
  opts: Opts<typeof rawSendTelegramAudio>,
): ReturnType<typeof rawSendTelegramAudio> => rawSendTelegramAudio(withCaption(opts));
export const sendTelegramVoice = (
  opts: Opts<typeof rawSendTelegramVoice>,
): ReturnType<typeof rawSendTelegramVoice> => rawSendTelegramVoice(withCaption(opts));

/**
 * The live WhatsApp socket, its `send` masked: the text and the caption of a
 * message content. The rest of the content (a file's bytes, a mention list)
 * is the platform's, untouched.
 */
export function ensureWhatsAppSocket(
  ...args: Parameters<typeof rawEnsureWhatsAppSocket>
): WhatsAppHandle {
  return outboundWhatsAppHandle(rawEnsureWhatsAppSocket(...args));
}

export function outboundWhatsAppHandle(handle: WhatsAppHandle): WhatsAppHandle {
  return {
    get bindingKey() {
      return handle.bindingKey;
    },
    get events() {
      return handle.events;
    },
    getStatus: () => handle.getStatus(),
    getIdentity: () => handle.getIdentity(),
    listGroups: () => handle.listGroups(),
    send: (jid, content) => {
      const fields = content as unknown as Record<string, unknown>;
      const masked: Record<string, unknown> = { ...fields };
      for (const key of ['text', 'caption'] as const) {
        const v = fields[key];
        if (typeof v === 'string') masked[key] = outboundText(v);
      }
      return handle.send(jid, masked as unknown as typeof content);
    },
  };
}

export function sendEmail(opts: EmailSendOpts): Promise<{ id: string }> {
  return rawSendEmail({
    ...opts,
    subject: outboundText(opts.subject),
    body: outboundText(opts.body),
  });
}

export function sendLog(opts: LogSendOpts): { messageId: string } {
  return rawSendLog({ ...opts, text: outboundText(opts.text) });
}
