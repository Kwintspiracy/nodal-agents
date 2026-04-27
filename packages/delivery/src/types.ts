// types.ts — DeliveryChannel, DeliveryResult, and related interfaces

export type DeliveryChannel = 'telegram' | 'email' | 'log';

export type DeliveryStatus = 'sent' | 'skipped' | 'failed';

export interface DeliveryResult {
  status: DeliveryStatus;
  channel: DeliveryChannel | null;
  messageIds: string[];
  reason?: string;
}

export interface DeliveryDeps {
  db: import('@nodalai/db').AnyDrizzleDb;
  telegramBotToken?: string;
  emailFrom?: string;
}

export interface DeliveryOptions {
  channelOverride?: DeliveryChannel;
  maxLength?: number;
}

export interface FormatOpts {
  maxLength?: number;
  includeJobId?: boolean;
}
