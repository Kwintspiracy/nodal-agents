// communication/telegram-send-message.ts — outbound Telegram message tool
//
// Registered per-agent when agents.telegramBotToken IS NOT NULL.
// The agent calls this tool to send a reply back to a Telegram chat.
// Credentials are fetched from the DB at execution time (never in closure).

import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import { sendTelegramMessage } from '@nodal-agents/delivery';
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
  original request (the job's origin chat).
- **text**: the message body. Plain text or HTML (Telegram HTML parse mode).

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

Fail conditions:
- If no chatId is provided and the current job has no origin chat, the tool throws
  \`telegram_no_recipient\`. This is intentional — do not guess a chat ID.
- If the agent has no configured Telegram bot token, the tool throws
  \`telegram_no_bot_token\`. Fix: configure the bot token in agent settings.`,

    inputSchema: TelegramSendMessageInput,

    riskLevel: 'write',

    async execute(
      input: TelegramSendMessageInput,
      ctx: ToolContext,
    ): Promise<TelegramSendMessageOutput> {
      // 1. Resolve chatId — explicit arg wins, then job origin chat
      const chatId = input.chatId ?? ctx.jobChatId;
      if (!chatId) {
        const err = new Error('telegram_no_recipient');
        err.name = 'telegram_no_recipient';
        throw err;
      }

      // 2. Fetch bot token for this agent from DB (credential isolation per agent)
      const agentRows = await ctx.db
        .select({ telegramBotToken: agents.telegramBotToken })
        .from(agents)
        .where(eq(agents.id, ctx.agentId))
        .limit(1);

      const botToken = agentRows[0]?.telegramBotToken;
      if (!botToken) {
        const err = new Error('telegram_no_bot_token');
        err.name = 'telegram_no_bot_token';
        throw err;
      }

      // 3. Send via the battle-tested delivery helper
      const res = await sendTelegramMessage({
        chatId,
        text: input.text,
        botToken,
      });

      return { messageId: String(res.messageId) };
    },
  };
}
