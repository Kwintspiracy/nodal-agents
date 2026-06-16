// communication — outbound messaging tools
// Each tool is registered per-agent at job time based on agent capabilities.

export { createTelegramSendMessageTool } from './telegram-send-message';
export { createSendImageTool } from './send-image';
