// index.ts — public API for @nodalai/delivery

export { deliverResult } from './deliver.ts';
export type { DeliveryDeps, DeliveryOptions, DeliveryResult } from './deliver.ts';

export { formatJobResult } from './format.ts';
export type { FormatJobInput } from './format.ts';
export type { FormatOpts } from './types.ts';

export { sendTelegramMessage } from './channels/telegram.ts';
export type { TelegramSendOpts } from './channels/telegram.ts';

export { sendEmail } from './channels/email.ts';
export type { EmailSendOpts } from './channels/email.ts';

export { sendLog } from './channels/log.ts';
export type { LogSendOpts } from './channels/log.ts';

export { DeliveryError } from './errors.ts';
export type { DeliveryErrorCode } from './errors.ts';

export type { DeliveryChannel, DeliveryStatus } from './types.ts';
