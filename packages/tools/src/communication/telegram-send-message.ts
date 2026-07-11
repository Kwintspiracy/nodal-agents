// communication/telegram-send-message.ts — outbound Telegram message tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL.
// The agent calls this tool to send a reply back to a Telegram chat.
// Credentials are fetched from the DB at execution time (never in closure).
//
// S3 (multichannel plan): sends through the channel-neutral ChannelAdapter
// (getAdapter) rather than calling the Telegram send helper directly. The
// tool's NAME, Zod schema, and error names are unchanged this phase — only
// the transport plumbing moved. resolveChannelForJob picks the adapter (today
// this only ever resolves 'telegram', since that's the only registered
// transport — see resolveTransportChannel).

import { z } from 'zod';
import { getAdapter } from '@nodal-agents/delivery';
import { resolveBotToken, resolveRecipientChatId, resolveChannelForJob } from './delivery-guard';
import type { ToolDefinition, ToolContext } from '../types';

// ─── Input / Output ───────────────────────────────────────────────────────────

const TelegramSendMessageInput = z.object({
  chatId: z
    .string()
    .regex(/^-?\d+$/, 'must be a numeric Telegram chat ID')
    .max(20)
    .optional()
    .describe('Telegram chat ID to send to. Omit to reply to the chat that triggered this job.'),
  text: z.string().min(1).max(4096).describe('The message text to send.'),
});

type TelegramSendMessageInput = z.infer<typeof TelegramSendMessageInput>;
type TelegramSendMessageOutput = { messageId: string };

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the telegram_send_message tool definition.
 *
 * Factory shape so the definition is stateless — all state (bot token,
 * chatId fallback) is resolved at execute-time from ctx.
 */
export function createTelegramSendMessageTool(): ToolDefinition<
  typeof TelegramSendMessageInput,
  TelegramSendMessageOutput
> {
  return {
    name: 'telegram_send_message',
    description: `Send a Telegram message to a user or chat.

Use this tool to deliver a reply, notification, or result via Telegram.

- **chatId**: optional. Provide it only when sending to a chat other than the one
  that triggered this job. If you omit it, the platform uses the chat that sent the
  original request (the job's origin chat). An explicit chatId must already be an
  APPROVED chat for this agent (the owner, or a member the owner confirmed) —
  you cannot message an arbitrary chat id.
- **text**: the message body, sent as plain text (no HTML/Markdown parsing).

**Same-response multi-call (CRITICAL for cost & latency)**:
When you need to send multiple messages (long replies split across the
4096-char Telegram limit), emit MULTIPLE \`telegram_send_message\` tool calls
IN THE SAME response.content array, alongside \`return_result\` at the end.
The runtime executes parallel tool calls correctly. Splitting calls across
consecutive responses wastes ~7× input tokens and adds latency for no benefit.

Correct (1 LLM round-trip):
  response.content = [
    { tool-call: telegram_send_message, input: { text: part1 } },
    { tool-call: telegram_send_message, input: { text: part2 } },
    { tool-call: telegram_send_message, input: { text: part3 } },
    { tool-call: return_result, input: { status: 'success' } }
  ]

Wrong (4 LLM round-trips for the same outcome):
  response 1: [{ telegram_send_message: part1 }]
  response 2: [{ telegram_send_message: part2 }]
  response 3: [{ telegram_send_message: part3 }]
  response 4: [{ return_result: ... }]

**Stop when you're done**: once you have sent your reply, call \`return_result\`
to end your turn. Do NOT keep sending standalone acknowledgements, follow-ups, or
emoji-only messages turn after turn — the user did not ask for them and the
platform will cut you off for spamming if you send on several turns in a row
without finishing.

Fail conditions:
- If no chatId is provided and the current job has no origin chat, the tool throws
  \`telegram_no_recipient\`. This is intentional — do not guess a chat ID.
- If the agent has no configured Telegram bot token, the tool throws
  \`telegram_no_bot_token\`. Fix: configure the bot token in agent settings.
- If an explicit chatId is not an approved chat for this agent, the tool throws
  \`telegram_chat_not_allowed\`.`,

    inputSchema: TelegramSendMessageInput,

    riskLevel: 'write',

    async execute(
      input: TelegramSendMessageInput,
      ctx: ToolContext,
    ): Promise<TelegramSendMessageOutput> {
      // 1. Resolve + authorize chatId — explicit arg wins (must be approved
      // unless it's the job's own origin chat), then job origin chat (F1).
      const chatId = await resolveRecipientChatId(input.chatId, ctx, 'telegram_no_recipient');

      // 2. Bot token — the runner's resolved token wins (B3: a delegated worker
      // inheriting its entity's root agent's token); otherwise fall back to this
      // agent's own token from DB (credential isolation per agent, historical path).
      const botToken = await resolveBotToken(ctx);
      if (!botToken) {
        const err = new Error('telegram_no_bot_token');
        err.name = 'telegram_no_bot_token';
        throw err;
      }

      // 3. Send via the channel-neutral adapter (battle-tested Telegram delivery
      // helper underneath — see channels/telegram-adapter.ts).
      const adapter = getAdapter(resolveChannelForJob(ctx));
      const res = await adapter.sendText({ botToken }, chatId, input.text);

      return { messageId: res.messageId };
    },
  };
}
