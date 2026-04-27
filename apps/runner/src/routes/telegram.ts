// routes/telegram.ts — POST /api/telegram — Telegram webhook receiver
// 1:1 port of legacy api/telegram.py

import type { Context } from 'hono';
import { eq, and } from '@nodalai/db';
import { agents } from '@nodalai/db';
import { agentJobs } from '@nodalai/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from './agent.ts';

// ─── Telegram update shape (minimal) ─────────────────────────────────────────

interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { first_name?: string; username?: string; is_bot?: boolean };
    reply_to_message?: { from?: { is_bot?: boolean } };
  };
  callback_query?: unknown;
}

// ─── telegramRoute ────────────────────────────────────────────────────────────

export async function telegramRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  // Always return 200 to Telegram — never let it retry
  try {
    await _handleTelegramUpdate(c, deps, runnerEnv);
  } catch {
    // Swallow all errors — Telegram must get a 200 or it retries indefinitely
  }

  return c.json({ ok: true }, 200);
}

async function _handleTelegramUpdate(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<void> {
  // Resolve agent from query param
  const agentSlug = c.req.query('agent_slug') ?? null;

  let agentId: string | null = null;
  let entityId: string | null = null;
  let webhookSecret: string | null = null;

  if (agentSlug) {
    const agentRows = await deps.db
      .select({
        id: agents.id,
        entityId: agents.entityId,
        telegramWebhookSecret: agents.telegramWebhookSecret,
      })
      .from(agents)
      .where(and(eq(agents.slug, agentSlug), eq(agents.active, true)))
      .limit(1);

    const agentRow = agentRows[0];
    if (agentRow) {
      agentId = agentRow.id;
      entityId = agentRow.entityId;
      webhookSecret = agentRow.telegramWebhookSecret;
    }
  }

  // Verify webhook secret
  const secret = webhookSecret ?? process.env['TELEGRAM_WEBHOOK_SECRET'] ?? '';
  if (!secret) {
    return; // No secret configured — reject silently
  }

  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (providedSecret !== secret) {
    return; // Invalid secret — reject silently
  }

  // Parse the update
  const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
  if (!update) return;

  const message = update.message;
  if (!message) return;

  const text = message.text ?? '';
  const chat = message.chat ?? {};
  const chatId = chat.id;
  const chatType = chat.type ?? 'private';
  const sender = message.from ?? {};
  const senderName = sender.first_name ?? 'Someone';
  const senderUsername = sender.username ?? '';

  if (!text || !chatId) return;

  // Group chat filtering: only respond if mentioned or command
  if (chatType === 'group' || chatType === 'supergroup') {
    const isCommand = text.startsWith('/ask ') || text.startsWith('/agents') || text === '/start';
    const replyToBot = message.reply_to_message?.from?.is_bot === true;
    if (!isCommand && !replyToBot) return;
  }

  // Resolve agent for /ask command
  if (text.startsWith('/ask ')) {
    const parts = text.slice(5).trim().split(' ');
    const askSlug = parts[0] ?? '';
    const askText = parts.slice(1).join(' ');

    if (!askText) return;

    const rows = await deps.db
      .select({ id: agents.id, entityId: agents.entityId })
      .from(agents)
      .where(and(eq(agents.slug, askSlug), eq(agents.active, true)))
      .limit(1);

    const row = rows[0];
    if (!row) return;

    agentId = row.id;
    entityId = row.entityId;

    await _createAndTriggerJob(deps, runnerEnv, agentId, entityId, askText, String(chatId));
    return;
  }

  // Default: create job for the task text
  const taskText =
    chatType === 'group' || chatType === 'supergroup'
      ? `[Message from ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}]: ${text}`
      : text;

  await _createAndTriggerJob(deps, runnerEnv, agentId, entityId, taskText, String(chatId));
}

async function _createAndTriggerJob(
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
  agentId: string | null,
  entityId: string | null,
  task: string,
  chatId: string,
): Promise<void> {
  const [job] = await deps.db
    .insert(agentJobs)
    .values({
      entityId: entityId ?? undefined,
      agentId: agentId ?? undefined,
      channel: 'telegram',
      task,
      chatId,
      status: 'pending',
      messages: [{ role: 'user', content: task }],
    })
    .returning({ id: agentJobs.id });

  if (!job) return;

  void triggerWorker(job.id, runnerEnv);
}
