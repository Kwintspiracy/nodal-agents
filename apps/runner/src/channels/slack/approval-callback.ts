// channels/slack/approval-callback.ts — resolve an approval from a Slack
// block_actions button tap. Mirrors channels/discord/approval-callback.ts's
// SECURITY GATES (DM-only, agent/conversation match, already-resolved race)
// against channel='slack' conversations via the neutral tables, then funnels
// through the SAME channel-neutral core (approvals/resolve.ts) telegram and
// discord use.
//
// parseApprovalCallbackData is REUSED as-is from telegram/approval-callback.ts
// — it's pure parsing of the `apr:<id>:<a|r>` wire format with no
// Telegram-specific API calls, already channel-neutral (discord reuses the
// exact same import).
//
// CLEANUP NOTE: resolveSlackApprovalTarget below duplicates
// resolveDiscordApprovalTarget's parent-chain walk almost verbatim — see that
// file's own CLEANUP NOTE (apps/runner/src/channels/discord/approval-callback.ts)
// for why a shared, channel-parametric walk is cleanup-phase work, not this
// ticket.

import { eq, and } from '@nodal-agents/db';
import {
  approvalRequests,
  agentJobs,
  channelAllowedConversations,
  getChannelBinding,
} from '@nodal-agents/db';
import {
  parseApprovalCallbackData,
  type ApprovalCallbackDecision,
} from '../../telegram/approval-callback.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import type { SlackInteractionAck } from './types.ts';

export { parseApprovalCallbackData };

export interface SlackApprovalTarget {
  /** Agent that OWNS the slack binding (the orchestrator on delegated chains). */
  agentId: string;
  /** The owner's Slack conversation (DM channel) id — the only place an approval tap is authorized from. */
  channelId: string;
}

/**
 * Resolve which slack-bound agent can deliver for a job, walking
 * parent_job_id upward (mirrors resolveDiscordApprovalTarget), then swapping
 * that agent's chat_id for its `role='owner', status='active'` conversation —
 * SECURITY (self-approval hole, mirrors resolveApprovalDeliveryTarget): the
 * card must always land in the bot OWNER's conversation, never the chat that
 * triggered the gated job.
 *
 * DEFENSE-IN-DEPTH: the walk must never cross an entity boundary — fails
 * loud (returns null) the moment an ancestor's entity_id diverges from the
 * starting job's.
 */
export async function resolveSlackApprovalTarget(
  db: RunnerDeps['db'],
  jobId: string,
): Promise<SlackApprovalTarget | null> {
  let current: string | null = jobId;
  let chatId: string | null = null;
  let startEntityId: string | null | undefined;

  for (let hops = 0; current && hops < 8; hops += 1) {
    const [row] = await db
      .select({
        parentJobId: agentJobs.parentJobId,
        chatId: agentJobs.chatId,
        entityId: agentJobs.entityId,
        agentId: agentJobs.agentId,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, current))
      .limit(1);
    if (!row) break;

    if (startEntityId === undefined) {
      startEntityId = row.entityId;
    } else if (row.entityId !== startEntityId) {
      console.error(
        `[slack-approval] SECURITY: delivery walk crossed an entity boundary — starting job ` +
          `${jobId} (entity ${startEntityId}) reached ancestor job ${current} (entity ${row.entityId}). ` +
          'Aborting the walk, no delivery target resolved.',
      );
      return null;
    }

    const rc: string | null = row.chatId ?? chatId;
    // agent_jobs.agent_id is nullable at the schema level (deleted/orphaned
    // rows) — a row with no agent can't be a delivery point, just keep walking.
    if (rc !== null && row.agentId) {
      const rowAgentId = row.agentId;
      const binding = await getChannelBinding(db, rowAgentId, 'slack');
      if (binding?.enabled) {
        const [ownerRow] = await db
          .select({ conversationId: channelAllowedConversations.conversationId })
          .from(channelAllowedConversations)
          .where(
            and(
              eq(channelAllowedConversations.agentId, rowAgentId),
              eq(channelAllowedConversations.channel, 'slack'),
              eq(channelAllowedConversations.role, 'owner'),
              eq(channelAllowedConversations.status, 'active'),
            ),
          )
          .limit(1);
        if (!ownerRow) return null;
        return { agentId: rowAgentId, channelId: ownerRow.conversationId };
      }
    }
    chatId = rc;
    current = row.parentJobId;
  }
  return null;
}

export type SlackApprovalInteractionResult =
  | { handled: true; decision: 'approve' | 'reject'; jobId: string }
  | { handled: false; reason: string };

export async function handleSlackApprovalInteraction(args: {
  parsed: { approvalRequestId: string; decision: ApprovalCallbackDecision };
  channelId: string;
  channelType: 'im' | 'channel';
  /** The agent whose gateway received this interaction — must own the resolved delivery target (defense in depth). */
  receivingAgentId: string;
  ack: SlackInteractionAck;
  deps: RunnerDeps;
  env: RunnerEnv;
}): Promise<SlackApprovalInteractionResult> {
  const { parsed, channelId, channelType, receivingAgentId, ack, deps, env } = args;

  // Le flux « Toujours autoriser » (suffixes w/wc/wb) est Telegram-only pour
  // l'instant — la carte Slack ne porte pas ce bouton : refus honnête.
  if (parsed.decision !== 'approve' && parsed.decision !== 'reject') {
    await ack.ephemeralReply('Standing rules can only be granted from the dashboard.');
    return { handled: false, reason: 'unsupported_decision' };
  }

  // SECURITY (mirrors discord's 2026-07-04 decision): approvals are DM-only
  // — a channel has multiple members who could tap the same button.
  if (channelType !== 'im') {
    await ack.ephemeralReply('Approvals can only be given in a DM with the bot.');
    return { handled: false, reason: 'not_dm' };
  }

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
    await ack.ephemeralReply('This request no longer exists.');
    return { handled: false, reason: 'approval_not_found' };
  }

  const target = await resolveSlackApprovalTarget(deps.db, approval.jobId);
  if (!target) {
    await ack.ephemeralReply('Not authorized.');
    return { handled: false, reason: 'no_delivery_target' };
  }

  // Defense in depth: the tap must arrive on the bot that owns this delivery target.
  if (target.agentId !== receivingAgentId) {
    await ack.ephemeralReply('Not authorized.');
    return { handled: false, reason: 'agent_mismatch' };
  }

  // SECURITY: the tap must come from the conversation the card was delivered to.
  if (channelId !== target.channelId) {
    await ack.ephemeralReply('Not authorized.');
    return { handled: false, reason: 'chat_mismatch' };
  }

  if (approval.status !== 'pending') {
    await ack.ephemeralReply(`Already ${approval.status}.`);
    return { handled: false, reason: 'already_resolved' };
  }

  const result = await resolveApprovalDecision(deps, env, {
    approvalRequestId: parsed.approvalRequestId,
    decision: parsed.decision,
    resolvedBy: 'slack',
  });

  if (!result.ok) {
    // Lost a race between the pending check and the resolve, or the job vanished.
    await ack.ephemeralReply('Could not apply — try the dashboard.');
    return { handled: false, reason: result.code };
  }

  const verb = parsed.decision === 'approve' ? 'Approved' : 'Rejected';
  const mark = parsed.decision === 'approve' ? '✅' : '❌';
  await ack.resolveCard(`${mark} ${verb} — ${approval.toolName}`);

  return { handled: true, decision: parsed.decision, jobId: result.jobId };
}
