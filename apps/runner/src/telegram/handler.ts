// telegram/handler.ts — turn a Telegram update into an agent_jobs row.
//
// Pure logic, no HTTP or polling concerns. The poller calls handleTelegramUpdate
// inside a transaction that also advances the agent's `telegram_offset` cursor,
// so a crash mid-update doesn't drop the message OR create a duplicate job.

import { eq, and } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import type { TelegramUpdate } from '@nodalai/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from '../routes/agent.ts';

export interface HandleResult {
  /** A job was created — caller should triggerWorker after txn commits. */
  jobId?: string;
  /** The update was filtered out (group chat noise, bot reply, empty text). */
  skipped?: 'no_message' | 'no_text' | 'group_filter' | 'ask_no_text' | 'ask_unknown_agent';
}

export async function handleTelegramUpdate(args: {
  update: TelegramUpdate;
  receivingAgentId: string;
  receivingAgentEntityId: string;
  /** Drizzle DB or transaction object — must support insert/select on these tables. */
  tx: RunnerDeps['db'];
}): Promise<HandleResult> {
  const { update, receivingAgentId, receivingAgentEntityId, tx } = args;

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

  // Group chat: only respond to commands or replies to the bot itself.
  if (chatType === 'group' || chatType === 'supergroup') {
    const isCommand =
      text.startsWith('/ask ') || text.startsWith('/agents') || text === '/start';
    const replyToBot = message.reply_to_message?.from?.is_bot === true;
    if (!isCommand && !replyToBot) return { skipped: 'group_filter' };
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
  } else if (chatType === 'group' || chatType === 'supergroup') {
    // For non-/ask group messages, prefix the sender's name so the agent
    // sees who said what.
    taskText = `[Message from ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}]: ${text}`;
  }

  const [job] = await tx
    .insert(agentJobs)
    .values({
      entityId: receivingAgentEntityId,
      agentId: targetAgentId,
      channel: 'telegram',
      task: taskText,
      chatId: String(chatId),
      status: 'pending',
      messages: [{ role: 'user', content: taskText }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    // Insert returned no row — the caller's transaction will roll this back
    // and the offset won't advance, so the next poll re-delivers this update.
    throw new Error('telegram_job_insert_failed');
  }

  return { jobId: job.id };
}

/**
 * Fire-and-forget triggerWorker. Called by the poller AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}
