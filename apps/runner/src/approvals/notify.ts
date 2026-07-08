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

import { eq, and } from '@nodal-agents/db';
import { agents, agentJobs, telegramAllowedChats } from '@nodal-agents/db';
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
 * Resolve the delivery target for an APPROVAL CARD specifically — SECURITY
 * (self-approval hole): `resolveTelegramDeliveryTarget` above answers "which
 * bot + chat did this job run in", which for an ordinary reply is exactly
 * right, but for an approve/reject card is wrong whenever the job was
 * triggered by a `member` chat (an authorized non-owner — H-1 onboarding).
 * Sending the buttons back to that SAME chat lets the member tap ✅ on their
 * own gated action. The card must instead always land in the bot OWNER's
 * private chat — the owner is the one who can actually authorize the agent's
 * actions.
 *
 * Resolves by walking the delegation chain (as above) to find the delivering
 * bot, then swapping its chat_id for the `role='owner', status='active'` row
 * on `telegram_allowed_chats`. A job run by the owner's own chat is already
 * the owner chat, so this is a no-op there (no behavior change for the common
 * case) — only a guest/member-triggered job sees the card move.
 *
 * An active `member` row always implies an `owner` row exists (H-1's
 * onboarding flow: nobody becomes `member` before someone is `owner`), so the
 * "no owner found" branch is a defensive fail-loud, not an expected path — it
 * returns null (no Telegram card; the approval stays resolvable from the
 * dashboard) rather than ever falling back to the triggering chat.
 */
export async function resolveApprovalDeliveryTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<TelegramDeliveryTarget | null> {
  const base = await resolveTelegramDeliveryTarget(db, jobId);
  if (!base) return null;
  const [ownerRow] = await db
    .select({ chatId: telegramAllowedChats.chatId })
    .from(telegramAllowedChats)
    .where(
      and(
        eq(telegramAllowedChats.agentId, base.agentId),
        eq(telegramAllowedChats.role, 'owner'),
        eq(telegramAllowedChats.status, 'active'),
      ),
    )
    .limit(1);
  if (!ownerRow) return null;
  return { agentId: base.agentId, botToken: base.botToken, chatId: ownerRow.chatId };
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
    // Resolve the bot + chat that must receive the approval card. On a
    // delegated chain the gated job's own agent may have no bot — the
    // orchestrator's bot delivers. And regardless of who triggered the job,
    // the card always goes to the bot OWNER's chat (never the triggering
    // chat — see resolveApprovalDeliveryTarget). null ⇒ no bot anywhere in
    // the chain, no chat, or no owner on record → stay silent (dashboard-only).
    const target = await resolveApprovalDeliveryTarget(deps.db, req.jobId);
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
