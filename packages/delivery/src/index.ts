// index.ts — public API for @nodal-agents/delivery

// Every sender is the seam's (outbound-channel.ts): what it posts is masked.
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
  TELEGRAM_MAX_FILE_BYTES,
  answerTelegramCallback,
  editTelegramMessageText,
  addTelegramBotCommands,
  setTelegramMessageReaction,
  telegramAdapter,
  discordAdapter,
  slackAdapter,
  whatsappAdapter,
  deviceAdapter,
  bindDeviceSink,
  ensureWhatsAppSocket,
  closeWhatsAppSocket,
  outboundAdapter,
  sendEmail,
  sendLog,
} from './outbound-channel.ts';
export type {
  TelegramSendOpts,
  TelegramBotInfo,
  TelegramUpdate,
  TelegramFileDownload,
  TelegramFileRef,
  TelegramInlineButton,
  TelegramInlineKeyboard,
  TelegramBotCommand,
} from './channels/telegram.ts';

export type { EmailSendOpts } from './channels/email.ts';

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
  QuestionCard,
  SendResult,
  EditResult,
  CardButton,
  ButtonCard,
  CardChoice,
  CardImage,
  ChoiceCard,
  BotIdentity,
  ChannelCapabilities,
  ChannelAdapter,
  TextDelivery,
  DiscoveredConversation,
} from './channel-adapter.ts';

export type { DeviceAddress, DeviceOutbound, DeviceSink } from './channels/device-adapter.ts';

export type {
  WhatsAppHandle,
  WhatsAppStatus,
  WhatsAppSocketOpts,
  WhatsAppInboundMessage,
  WhatsAppEventEmitter,
} from './channels/whatsapp/socket-manager.ts';

export { getAdapter, textDeliveryOf } from './registry.ts';

export {
  resolveTransportChannel,
  listActiveChannelsForAgent,
  isTransportChannel,
  isMessagingChannel,
  CHANNEL_REACH,
  defaultSendChannel,
  jobChatOn,
  resolveOwnerNoticeTarget,
} from './transport-channel.ts';
export type { JobChat, MessagingChannelKind } from './transport-channel.ts';
