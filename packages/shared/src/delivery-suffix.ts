// delivery-suffix.ts — format a prompt delivery instruction suffix.
//
// Used by job creation entry points (dashboard sendTaskAction, Telegram
// inbound handler, future Slack/Discord/etc.) to append a structured
// "## Delivery channels" block to the task. The agent's personality reads
// this block and uses the listed tools to deliver the final result.
//
// Single source of truth so cross-app drift can't introduce divergent formats.

export interface DeliveryChannel {
  kind: 'telegram'; // future: 'whatsapp', 'slack', etc.
  identifier: string; // chatId for telegram, phone for whatsapp, etc.
}

export function formatPromptDeliverySuffix(channels: DeliveryChannel[]): string {
  if (channels.length === 0) return '';
  const lines = channels.map((c) => {
    switch (c.kind) {
      case 'telegram':
        return `- Telegram (chat_id: ${c.identifier})`;
      default: {
        // exhaustive — TypeScript will error if a new kind is added without handling
        const _never: never = c.kind;
        throw new Error(`Unhandled delivery channel kind: ${String(_never)}`);
      }
    }
  });
  return `\n\n## Delivery channels\n${lines.join('\n')}\n\nUse the corresponding tool(s) to deliver the final result on each channel.`;
}
