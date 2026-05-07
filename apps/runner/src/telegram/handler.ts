// telegram/handler.ts — turn a Telegram update into an agent_jobs row.
//
// Pure logic, no HTTP or polling concerns. The poller calls handleTelegramUpdate
// inside a transaction that also advances the agent's `telegram_offset` cursor,
// so a crash mid-update doesn't drop the message OR create a duplicate job.
//
// Group chat triggers — the bot only reacts when the user clearly addressed it:
//   - `/ask <slug> <text>`         → route to a different agent in the entity
//   - `/agents` or `/start`        → reserved commands
//   - `@bot_username ...`          → mention with the bot's username
//   - reply to a previous bot msg  → continuation
// Anything else in a group is ignored to avoid the bot replying to every line.

import { eq, and } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import type { TelegramUpdate } from '@nodalai/delivery';
import { formatPromptDeliverySuffix, type DeliveryChannel } from '@nodalai/shared';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from '../routes/agent.ts';

export interface HandleResult {
  /** A job was created — caller should triggerWorker after txn commits. */
  jobId?: string;
  /** The update was filtered out. */
  skipped?:
    | 'no_message'
    | 'no_text'
    | 'group_filter'
    | 'ask_no_text'
    | 'ask_unknown_agent'
    | 'mention_no_text';
}

export async function handleTelegramUpdate(args: {
  update: TelegramUpdate;
  receivingAgentId: string;
  receivingAgentEntityId: string;
  /**
   * The bot's @username (without the @). Required to detect mentions in
   * group chats. Null is tolerated — mention-trigger will be skipped.
   */
  receivingAgentBotUsername: string | null;
  /** Drizzle DB or transaction object — must support insert/select on these tables. */
  tx: RunnerDeps['db'];
}): Promise<HandleResult> {
  const { update, receivingAgentId, receivingAgentEntityId, receivingAgentBotUsername, tx } = args;

  const message = update.message;
  if (!message) return { skipped: 'no_message' };

  const text = message.text ?? '';
  const chat = message.chat ?? {};
  const chatId = chat.id;
  const chatType = chat.type ?? 'private';
  const sender = message.from ?? {};
  const senderName = sender.first_name ?? 'Someone';
  const senderUsername = sender.username ?? '';

  if (!text || chatId === undefined) return { skipped: 'no_text' };

  const isGroup = chatType === 'group' || chatType === 'supergroup';

  // Detect a mention of the bot. Telegram usernames are case-insensitive,
  // so compare lowercased. Surrounding word-boundary chars include space and
  // line breaks; a regex with the literal token is good enough.
  const mentionToken = receivingAgentBotUsername
    ? `@${receivingAgentBotUsername}`.toLowerCase()
    : '';
  const isMention = mentionToken !== '' && text.toLowerCase().includes(mentionToken);

  // Group chat: only respond to commands, mentions, or replies to the bot.
  if (isGroup) {
    const isCommand = text.startsWith('/ask ') || text.startsWith('/agents') || text === '/start';
    const replyToBot = message.reply_to_message?.from?.is_bot === true;
    if (!isCommand && !isMention && !replyToBot) return { skipped: 'group_filter' };
  }

  // /ask <slug> <text> routes to a different agent in the same entity.
  let targetAgentId = receivingAgentId;
  let taskText = text;

  if (text.startsWith('/ask ')) {
    const parts = text.slice(5).trim().split(/\s+/);
    const askSlug = parts[0] ?? '';
    const askText = parts.slice(1).join(' ');

    if (!askText) return { skipped: 'ask_no_text' };

    const rows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.slug, askSlug),
          eq(agents.entityId, receivingAgentEntityId),
          eq(agents.active, true),
        ),
      )
      .limit(1);

    const targetRow = rows[0];
    if (!targetRow) return { skipped: 'ask_unknown_agent' };

    targetAgentId = targetRow.id;
    taskText = askText;
  } else if (isGroup) {
    // Group chats: strip the @mention if present so the agent doesn't see
    // its own handle in the prompt; then prefix with sender name so it
    // knows who's speaking.
    let body = text;
    if (isMention) {
      body = body.replace(buildMentionRegex(receivingAgentBotUsername!), '').trim();
      if (!body) return { skipped: 'mention_no_text' };
    }
    taskText = `[Message from ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}]: ${body}`;
  }

  // Inject a "## Delivery channels" suffix so the agent knows the user is on
  // Telegram and must call telegram_send_message with this chat_id. The agent
  // personality reads the block and uses the listed tools — same contract as
  // dashboard send-task with the Telegram checkbox toggled. Without this,
  // Telegram-inbound jobs only call return_result and the user never gets a
  // reply on Telegram.
  const deliveryChannels: DeliveryChannel[] = [{ kind: 'telegram', identifier: String(chatId) }];
  const finalTask = taskText + formatPromptDeliverySuffix(deliveryChannels);

  const [job] = await tx
    .insert(agentJobs)
    .values({
      entityId: receivingAgentEntityId,
      agentId: targetAgentId,
      channel: 'telegram',
      task: finalTask,
      chatId: String(chatId),
      status: 'pending',
      messages: [{ role: 'user', content: finalTask }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    // Insert returned no row — the caller's transaction will roll this back
    // and the offset won't advance, so the next poll re-delivers this update.
    throw new Error('telegram_job_insert_failed');
  }

  // Atomically record the last-seen chat_id so the dashboard can offer
  // "send result via Telegram" for this agent.
  await tx
    .update(agents)
    .set({ lastSeenChatIdTelegram: String(chatId) })
    .where(eq(agents.id, receivingAgentId));

  return { jobId: job.id };
}

/**
 * Fire-and-forget triggerWorker. Called by the poller AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function buildMentionRegex(botUsername: string): RegExp {
  const escaped = botUsername.replace(REGEX_SPECIAL, '\\$&');
  return new RegExp(`@${escaped}`, 'gi');
}
