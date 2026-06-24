// index.ts — public API for @nodal-agents/delivery

export {
  sendTelegramMessage,
  sendTelegramPhoto,
  getTelegramBotInfo,
  getTelegramUpdates,
  answerTelegramCallback,
  editTelegramMessageText,
} from './channels/telegram.ts';
export type {
  TelegramSendOpts,
  TelegramBotInfo,
  TelegramUpdate,
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
