// communication — outbound messaging tools
// Each tool is registered per-agent at job time based on agent capabilities.

export { createTelegramSendMessageTool } from './telegram-send-message';
export { createSendImageTool } from './send-image';
export { createSendFileTool } from './send-file';
export { createSendVideoTool, createSendAudioTool, createSendVoiceTool } from './send-media';

// Single source of truth for "which tool names push a message to a human
// channel" — the runner's anti-spam/delivery guards and the orchestration
// package's brief-validation (B2) both need this exact set and must not drift
// out of sync with each other or with the createSend*Tool factories above.
export const DELIVERY_TOOL_NAMES = [
  'telegram_send_message',
  'send_image',
  'send_file',
  'send_video',
  'send_audio',
  'send_voice',
] as const;
