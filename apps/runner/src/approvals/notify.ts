// approvals/notify.ts — deterministic, server-sent approval notification.
//
// WHY this exists: before this, the ONLY signal that a job was waiting for
// approval on Telegram was a *nudge* asking the LLM to call telegram_send_message
// (execute.ts). That nudge was gated on `!telegramDelivered` and on the model
// actually complying — so in common cases (the agent had already sent any
// message, or simply ignored the nudge) the user got NOTHING and the job paused
// silently. This module makes the notification deterministic: the runner itself
// sends the message the instant the approval is created, regardless of the LLM.
//
// It also attaches ✅/❌ inline buttons so the user can resolve the approval from
// Telegram (handled by telegram/approval-callback.ts) — no dashboard required.
//
// Channel-neutral by construction: this is wired in via the tool layer's
// `onApprovalRequired` callback, which knows nothing about Telegram. A no-bot /
// no-chat job simply gets no card (the dashboard path is unaffected).

import { eq } from '@nodal-agents/db';
import { agents, agentJobs } from '@nodal-agents/db';
import { redactSecretsForAudit, computeApprovalImpactLine } from '@nodal-agents/shared';
import { sendTelegramMessage, type TelegramInlineKeyboard } from '@nodal-agents/delivery';
import type { ApprovalGateRequest } from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';

/** callback_data carried by the buttons. Parsed by approval-callback.ts. Stays well under Telegram's 64-byte cap. */
export const APPROVAL_CALLBACK_PREFIX = 'apr';
export function approvalCallbackData(approvalRequestId: string, decision: 'a' | 'r'): string {
  return `${APPROVAL_CALLBACK_PREFIX}:${approvalRequestId}:${decision}`;
}

/** The bot + chat that can actually reach the user for a (possibly delegated) job. */
export interface TelegramDeliveryTarget {
  /** Agent that OWNS the bot (the orchestrator on delegated chains) — the callback authority. */
  agentId: string;
  botToken: string;
  chatId: string;
}

/**
 * Resolve which bot can deliver a Telegram message for a job. A gate often fires
 * inside a DELEGATED sub-job whose agent has no bot (e.g. director) — the bot
 * that reaches the user belongs to the ORCHESTRATOR (e.g. alfred). Walk
 * parent_job_id from the gated job upward and return the first job whose agent
 * has a bot token, carrying the chat_id down the chain. Returns null when no
 * agent in the chain has a bot or no chat_id is set (→ dashboard-only job).
 */
export async function resolveTelegramDeliveryTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<TelegramDeliveryTarget | null> {
  let current: string | null = jobId;
  let chatId: string | null = null;
  for (let hops = 0; current && hops < 8; hops += 1) {
    const [row] = await db
      .select({
        parentJobId: agentJobs.parentJobId,
        chatId: agentJobs.chatId,
        agentId: agents.id,
        botToken: agents.telegramBotToken,
      })
      .from(agentJobs)
      .innerJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(eq(agentJobs.id, current))
      .limit(1);
    if (!row) break;
    const bt: string | null = row.botToken;
    const rc: string | null = row.chatId ?? chatId;
    if (bt !== null && rc !== null) {
      return { agentId: row.agentId, botToken: bt, chatId: rc };
    }
    chatId = rc;
    current = row.parentJobId;
  }
  return null;
}

/**
 * Render a short, human-readable summary of the gated action. PLAIN TEXT (no
 * Markdown) on purpose — tool input (e.g. an arbitrary shell command) must not be
 * able to break formatting or inject entities.
 */
export function describeGatedAction(toolName: string, toolInput: unknown): string {
  // NOUVEAU-1: mask secret-bearing fields before they reach the Telegram card.
  // The default case below dumps the whole input as JSON — for create_connector
  // / create_mcp / attach_mcp that would print the API key / stdio env values in
  // clear. run_command's `command` is not a secret field, so it is untouched.
  const input = redactSecretsForAudit(toolInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  switch (toolName) {
    case 'run_command':
      return `run_command:\n${str(input['command'])}`;
    case 'run_skill_script':
      return (
        `run_skill_script: ${str(input['skill'])} → ${str(input['script'])}` +
        (Array.isArray(input['args']) ? ` ${(input['args'] as unknown[]).map(str).join(' ')}` : '')
      );
    case 'skill_file_write':
      return `skill_file_write: ${str(input['skill'])} → ${str(input['path'])}`;
    default: {
      // Generic: tool name + a compact, truncated view of the input.
      const compact = str(input);
      return `${toolName}: ${compact.length > 300 ? compact.slice(0, 300) + '…' : compact}`;
    }
  }
}

/**
 * Send the deterministic approval card to the job's Telegram chat, with inline
 * approve/reject buttons. Best-effort: any failure is logged and swallowed — a
 * notification failure must never break the (already-persisted) approval gate.
 * No-ops silently when the job has no Telegram chat or the agent has no bot
 * token (e.g. dashboard/api/cron jobs) — those resolve from the dashboard.
 */
export async function notifyApprovalCreated(
  deps: RunnerDeps,
  req: ApprovalGateRequest,
): Promise<void> {
  try {
    // Resolve the bot that can reach the user. On a delegated chain the gated
    // job's own agent may have no bot — the orchestrator's bot delivers. null ⇒
    // no bot anywhere in the chain or no chat → dashboard-only job, stay silent.
    const target = await resolveTelegramDeliveryTarget(deps.db, req.jobId);
    if (!target) return;
    const { botToken, chatId } = target;

    // The acting agent (whose action is gated) names the card — NOT the bot owner.
    const [agent] = await deps.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, req.agentId))
      .limit(1);
    const who = agent?.name ?? 'An agent';
    // Three tiers, WHY first: (1) the agent's own plain-language purpose —
    // invariant #2 applies here, this is the agent's voice, so we show it
    // verbatim or admit it's missing rather than invent one; (2) a
    // deterministic, code-computed impact line (invariant #2 does NOT apply —
    // this is platform UI describing what the action DOES, never the
    // agent's voice); (3) the raw technical detail (command/path), secondary
    // and truncated — the reviewer decides on 1+2, not on a wall of shell.
    const input = (req.toolInput ?? {}) as Record<string, unknown>;
    const purpose = typeof input['purpose'] === 'string' ? input['purpose'].trim() : '';
    const impact = computeApprovalImpactLine(req.toolName, req.toolInput);
    const detail = describeGatedAction(req.toolName, req.toolInput);
    const detailShort =
      detail.length > 500 ? detail.slice(0, 500) + '\n… (full detail on the dashboard)' : detail;

    const text =
      `⏳ Approval needed — ${who}\n\n` +
      `➤ ${purpose || 'Purpose not specified by the agent.'}\n` +
      `⚠️ ${impact}\n` +
      `\nDetails:\n${detailShort}\n\n` +
      `Tap a button below to decide — or resolve it from the dashboard.`;

    const inlineKeyboard: TelegramInlineKeyboard = [
      [
        { text: '✅ Approve', callback_data: approvalCallbackData(req.approvalRequestId, 'a') },
        { text: '❌ Reject', callback_data: approvalCallbackData(req.approvalRequestId, 'r') },
      ],
    ];

    await sendTelegramMessage({ chatId, botToken, text, inlineKeyboard });
  } catch (err) {
    console.warn(
      `[approval-notify] failed to send approval card for ${req.approvalRequestId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
