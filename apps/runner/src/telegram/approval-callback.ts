// telegram/approval-callback.ts — resolve an approval from an inline-button tap.
//
// The poller subscribes to `callback_query` updates (button taps). When a tap
// carries our `apr:<approvalId>:<a|r>` payload, we:
//   1. parse + validate the payload,
//   2. SECURITY-GATE: the tap must come from the SAME chat the approval card was
//      sent to (the job's chat_id) AND target an approval owned by THIS agent —
//      so a button can only be actioned from the authorized conversation,
//   3. resolve via the shared channel-neutral core (approvals/resolve.ts),
//   4. ack the tap and rewrite the card to a resolved state (buttons stripped).
//
// Best-effort throughout: a failure to ack/edit must never mask the fact that
// the decision was (or wasn't) persisted.

import { eq } from '@nodal-agents/db';
import { approvalRequests } from '@nodal-agents/db';
import {
  answerTelegramCallback,
  editTelegramMessageText,
  type TelegramUpdate,
} from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveApprovalDecision } from '../approvals/resolve.ts';
import { APPROVAL_CALLBACK_PREFIX, resolveApprovalDeliveryTarget } from '../approvals/notify.ts';

export interface HandleApprovalCallbackArgs {
  update: TelegramUpdate;
  /** The polling agent — the approval must belong to it (defense in depth). */
  receivingAgentId: string;
  botToken: string;
  deps: RunnerDeps;
  env: RunnerEnv;
}

export type ApprovalCallbackResult =
  | { handled: true; decision: 'approve' | 'reject'; jobId: string }
  | { handled: false; reason: string };

/** Parse `apr:<uuid>:<a|r>` → { id, decision }, or null if it isn't ours / malformed. */
export function parseApprovalCallbackData(
  data: string | undefined,
): { approvalRequestId: string; decision: 'approve' | 'reject' } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== APPROVAL_CALLBACK_PREFIX) return null;
  const [, id, d] = parts;
  if (!id || (d !== 'a' && d !== 'r')) return null;
  return { approvalRequestId: id, decision: d === 'a' ? 'approve' : 'reject' };
}

export async function handleApprovalCallback(
  args: HandleApprovalCallbackArgs,
): Promise<ApprovalCallbackResult> {
  const { update, receivingAgentId, botToken, deps, env } = args;
  const cb = update.callback_query;
  if (!cb) return { handled: false, reason: 'no_callback_query' };

  const parsed = parseApprovalCallbackData(cb.data);
  if (!parsed) {
    // Not an approval button (or malformed) — ack so the client stops spinning.
    await answerTelegramCallback(botToken, cb.id);
    return { handled: false, reason: 'not_an_approval_callback' };
  }

  // SECURITY (decision 2026-07-04): approvals are DM-only. A group/supergroup
  // chat has multiple members who can tap the same inline button — the prior
  // chat-id check below only verified the TAP CAME FROM the right chat, not
  // that the right PERSON tapped it. Rather than try to identify "the right
  // person" in a group, refuse group approvals outright: reject anything that
  // isn't the bot's private chat with the requester, and do NOT resolve.
  const chatType = cb.message?.chat?.type;
  if (chatType !== 'private') {
    await answerTelegramCallback(
      botToken,
      cb.id,
      'Approvals can only be given in a private chat with the bot.',
      true,
    );
    return { handled: false, reason: 'not_private_chat' };
  }

  const tappedChatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;

  // Load the approval + its job to enforce the security boundary BEFORE resolving.
  const [approval] = await deps.db
    .select({
      id: approvalRequests.id,
      jobId: approvalRequests.jobId,
      agentId: approvalRequests.agentId,
      status: approvalRequests.status,
      toolName: approvalRequests.toolName,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, parsed.approvalRequestId))
    .limit(1);

  if (!approval) {
    await answerTelegramCallback(botToken, cb.id, 'This request no longer exists.', true);
    return { handled: false, reason: 'approval_not_found' };
  }

  // Resolve who SHOULD deliver/own this approval's chat. On a delegated chain the
  // approval's agent (e.g. director) has no bot — the card was sent via the
  // orchestrator's bot, not the worker's. SECURITY: the card (and therefore the
  // only chat a tap can be authorized from) always lives in the bot OWNER's
  // private chat, never the chat that triggered the gated job — a `member`
  // (authorized non-owner, H-1) must not be able to self-approve its own
  // action by tapping from its own chat. See resolveApprovalDeliveryTarget.
  const target = await resolveApprovalDeliveryTarget(deps.db, approval.jobId);
  if (!target) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'no_delivery_target' };
  }

  // Defense in depth: the tap must arrive on the bot that delivered the card
  // (the orchestrator that owns the chat), not some other agent's bot.
  if (target.agentId !== receivingAgentId) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'agent_mismatch' };
  }

  // SECURITY: the tap must come from the same chat the card was delivered to.
  const jobChatId = target.chatId;
  if (tappedChatId === undefined || String(tappedChatId) !== jobChatId) {
    await answerTelegramCallback(botToken, cb.id, 'Not authorized.', true);
    return { handled: false, reason: 'chat_mismatch' };
  }

  // Already resolved (e.g. the dashboard won the race) — tell the user, refresh card.
  if (approval.status !== 'pending') {
    await answerTelegramCallback(botToken, cb.id, `Already ${approval.status}.`);
    if (messageId !== undefined) {
      await editTelegramMessageText({
        botToken,
        chatId: jobChatId,
        messageId,
        text: `This request was already ${approval.status}.`,
      });
    }
    return { handled: false, reason: 'already_resolved' };
  }

  const result = await resolveApprovalDecision(deps, env, {
    approvalRequestId: parsed.approvalRequestId,
    decision: parsed.decision,
    resolvedBy: 'telegram',
  });

  if (!result.ok) {
    // Lost a race between the pending check and the resolve, or job vanished.
    await answerTelegramCallback(botToken, cb.id, 'Could not apply — try the dashboard.', true);
    return { handled: false, reason: result.code };
  }

  const verb = parsed.decision === 'approve' ? 'Approved' : 'Rejected';
  const mark = parsed.decision === 'approve' ? '✅' : '❌';
  await answerTelegramCallback(botToken, cb.id, `${mark} ${verb}`);
  if (messageId !== undefined) {
    await editTelegramMessageText({
      botToken,
      chatId: jobChatId,
      messageId,
      text: `${mark} ${verb} — ${approval.toolName}`,
    });
  }

  return { handled: true, decision: parsed.decision, jobId: result.jobId };
}
