// deliver.ts — deliverResult: main entry point

import { eq } from '@nodalai/db';
import { agentJobs, agents, entities, users } from '@nodalai/db';
import { DeliveryError } from './errors.ts';
import { formatJobResult } from './format.ts';
import { sendTelegramMessage } from './channels/telegram.ts';
import { sendEmail } from './channels/email.ts';
import { sendLog } from './channels/log.ts';
import type { DeliveryDeps, DeliveryOptions, DeliveryResult } from './types.ts';

export type { DeliveryDeps, DeliveryOptions, DeliveryResult };

/**
 * Deliver the result of a completed job to its recipient.
 *
 * Resolution order:
 *   1. If job.channel === 'telegram' AND job.chatId exists → telegram
 *   2. If entityId resolves to a user with email → email (placeholder, throws)
 *   3. Fallback: log channel (console.warn, useful for dev/tests)
 *
 * If the job has no result AND no error, delivery is skipped.
 */
export async function deliverResult(
  jobId: string,
  deps: DeliveryDeps,
  opts?: DeliveryOptions,
): Promise<DeliveryResult> {
  const { db, telegramBotToken } = deps;

  // ── 1. Load job ──────────────────────────────────────────────────────────────
  const rows = await db
    .select({
      id: agentJobs.id,
      task: agentJobs.task,
      result: agentJobs.result,
      error: agentJobs.error,
      channel: agentJobs.channel,
      chatId: agentJobs.chatId,
      agentId: agentJobs.agentId,
      entityId: agentJobs.entityId,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);

  const job = rows[0];
  if (!job) {
    throw new DeliveryError('delivery_job_not_found', `delivery_job_not_found: ${jobId}`);
  }

  // ── 2. Skip if nothing to deliver ───────────────────────────────────────────
  if (job.result === null && job.error === null) {
    return { status: 'skipped', channel: null, messageIds: [], reason: 'no_content' };
  }

  // ── 3. Resolve channel ───────────────────────────────────────────────────────
  const channelOverride = opts?.channelOverride;
  const maxLength = opts?.maxLength;

  const effectiveChannel =
    channelOverride ??
    (job.channel === 'telegram' && job.chatId ? 'telegram' : null) ??
    (job.entityId ? await resolveEmailChannel(db, job.entityId) : null) ??
    'log';

  // ── 4. Format message ────────────────────────────────────────────────────────
  const chunks = formatJobResult(
    {
      id: job.id,
      task: job.task,
      result: job.result,
      error: job.error,
      channel: job.channel,
    },
    { maxLength },
  );

  // ── 5. Dispatch to channel ───────────────────────────────────────────────────
  try {
    if (effectiveChannel === 'telegram') {
      return await deliverViaTelegram(job, chunks, telegramBotToken, db);
    }

    if (effectiveChannel === 'email') {
      return await deliverViaEmail(job, chunks, deps.emailFrom, db);
    }

    // log channel (fallback / dev / tests)
    return deliverViaLog(job, chunks);
  } catch (err) {
    if (err instanceof DeliveryError) {
      return { status: 'failed', channel: effectiveChannel, messageIds: [], reason: err.code };
    }
    throw err;
  }
}

// ─── Channel dispatchers ──────────────────────────────────────────────────────

async function deliverViaTelegram(
  job: {
    id: string;
    chatId: string | null;
    agentId: string | null;
  },
  chunks: string[],
  envToken: string | undefined,
  db: DeliveryDeps['db'],
): Promise<DeliveryResult> {
  // Prefer agent-specific bot token, fall back to env token
  let botToken = envToken;

  if (job.agentId) {
    const agentRows = await db
      .select({ telegramBotToken: agents.telegramBotToken })
      .from(agents)
      .where(eq(agents.id, job.agentId))
      .limit(1);
    const agentToken = agentRows[0]?.telegramBotToken;
    if (agentToken) botToken = agentToken;
  }

  if (!botToken) {
    throw new DeliveryError('telegram_no_token');
  }

  const chatId = job.chatId;
  if (!chatId) {
    throw new DeliveryError('telegram_no_chat_id');
  }

  const messageIds: string[] = [];
  for (const chunk of chunks) {
    const res = await sendTelegramMessage({
      chatId,
      text: chunk,
      botToken,
      parseMode: 'HTML',
      disableWebPagePreview: true,
    });
    messageIds.push(String(res.messageId));
  }

  return { status: 'sent', channel: 'telegram', messageIds };
}

async function deliverViaEmail(
  job: { id: string; entityId: string | null },
  chunks: string[],
  emailFrom: string | undefined,
  db: DeliveryDeps['db'],
): Promise<DeliveryResult> {
  if (!emailFrom) {
    throw new DeliveryError('delivery_email_not_configured');
  }

  let toEmail: string | null = null;
  if (job.entityId) {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .innerJoin(entities, eq(entities.userId, users.id))
      .where(eq(entities.id, job.entityId))
      .limit(1);
    toEmail = rows[0]?.email ?? null;
  }

  if (!toEmail) {
    // No email found — fall back to log
    return deliverViaLog(job, chunks);
  }

  // sendEmail is a stub; throws DeliveryError('delivery_email_not_configured')
  await sendEmail({
    to: toEmail,
    subject: `Job ${job.id}`,
    body: chunks.join('\n\n---\n\n'),
    from: emailFrom,
  });

  return { status: 'sent', channel: 'email', messageIds: [] };
}

function deliverViaLog(job: { id: string }, chunks: string[]): DeliveryResult {
  const ids: string[] = [];
  for (const chunk of chunks) {
    const res = sendLog({ text: chunk, jobId: job.id });
    ids.push(res.messageId);
  }
  return { status: 'sent', channel: 'log', messageIds: ids };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Try to resolve an email channel for an entity by looking up the owner's email.
 * Returns 'email' if found, null if not.
 */
async function resolveEmailChannel(
  db: DeliveryDeps['db'],
  entityId: string,
): Promise<'email' | null> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(entities, eq(entities.userId, users.id))
    .where(eq(entities.id, entityId))
    .limit(1);
  return rows[0]?.email ? 'email' : null;
}
