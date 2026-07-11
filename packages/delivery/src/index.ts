// index.ts — public API for @nodal-agents/delivery

export {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramDocument,
  sendTelegramVideo,
  sendTelegramAudio,
  sendTelegramVoice,
  getTelegramBotInfo,
  getTelegramUpdates,
  getTelegramFile,
  answerTelegramCallback,
  editTelegramMessageText,
} from './channels/telegram.ts';
export type {
  TelegramSendOpts,
  TelegramBotInfo,
  TelegramUpdate,
  TelegramFileDownload,
  TelegramInlineButton,
  TelegramInlineKeyboard,
} from './channels/telegram.ts';

export { sendEmail } from './channels/email.ts';
export type { EmailSendOpts } from './channels/email.ts';

export { sendLog } from './channels/log.ts';
export type { LogSendOpts } from './channels/log.ts';

export { DeliveryError } from './errors.ts';
export type { DeliveryErrorCode } from './errors.ts';

export type { DeliveryChannel, DeliveryStatus } from './types.ts';

export type {
  ChannelKind,
  ChannelCredentials,
  TextFormat,
  SendTextOpts,
  OutboundMedia,
  ApprovalCard,
  SendResult,
  BotIdentity,
  ChannelCapabilities,
  ChannelAdapter,
} from './channel-adapter.ts';

export { telegramAdapter } from './channels/telegram-adapter.ts';

export { discordAdapter } from './channels/discord-adapter.ts';

export { getAdapter } from './registry.ts';

export { resolveTransportChannel } from './transport-channel.ts';
