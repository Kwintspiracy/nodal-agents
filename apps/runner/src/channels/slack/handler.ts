// channels/slack/handler.ts — turn a Slack inbound message into an
// agent_jobs row. Pure logic, no @slack/bolt/network concerns — mirrors
// channels/discord/handler.ts's shape and H-1 authorization state machine via
// the SAME channel-neutral checkConversationAuthorization (channels/shared.ts;
// slack has no legacy table to dual-write into, exactly like discord).
//
// Bot-author messages are ALWAYS ignored — hard rule against ack-loops.
// socket.ts already filters these out at the SDK layer (bot_id / subtype
// check) before a SlackInboundMessage is ever constructed; the check here is
// re-run for direct unit-test coverage, same as discord/handler.ts's comment.
//
// Channel-kind triggers — unlike Discord, Slack's OWN event routing already
// is the mention gate (see types.ts's file header): socket.ts only ever
// builds a channelType='channel' message from an `app_mention` event, so this
// handler always strips the bot's own mention token before deciding what to
// do with the remaining text (a bare `/ask <slug> <text>` command, or a plain
// mention that becomes a "[Message from X]" prefixed task).
//
// Image/file intake is OUT OF SCOPE for this phase (Slack's file download
// needs a `files:read` + signed-URL flow the way Discord's inbound
// attachment.url doesn't) — text-only inbound is the MVT; a job never carries
// an `attachment` the way DiscordHandleResult does.

import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { triggerWorker } from '../../routes/agent.ts';
import { resolveConversationId } from '../../job/conversation-id.ts';
import { sanitizeSenderName, checkConversationAuthorization } from '../shared.ts';
import type { SlackInboundMessage } from './types.ts';

export interface SlackHandleResult {
  /** A job was created — caller should triggerJobWorker after the transaction commits. */
  jobId?: string;
  skipped?:
    | 'bot_author'
    | 'no_content'
    | 'ask_no_text'
    | 'ask_unknown_agent'
    | 'mention_no_text'
    | 'awaiting_authorization'
    | 'no_owner_group';
  /**
   * H-1: an UNKNOWN conversation messaged a bot that already has an owner. No
   * job is created; the gateway (after the txn commits) sends the owner a
   * button card to allow/deny, and tells the requester it is pending.
   */
  pendingAuth?: {
    conversationRowId: string;
    ownerConversationId: string;
    requesterConversationId: string;
    requesterName: string;
    targetAgentName?: string;
  };
}

const mentionRegexCache = new Map<string, RegExp>();

/** Matches Slack's own mention wire format for a user id: `<@ID>` or the
 *  labeled form `<@ID|display_name>`. */
function mentionRegex(userId: string): RegExp {
  let re = mentionRegexCache.get(userId);
  if (!re) {
    re = new RegExp(`<@${userId}(\\|[^>]*)?>`, 'g');
    mentionRegexCache.set(userId, re);
  }
  return re;
}

export async function handleSlackMessage(args: {
  message: SlackInboundMessage;
  receivingAgentId: string;
  receivingAgentEntityId: string;
  /** This bot's own Slack user id — required to strip the mention token from
   *  a channel-kind message. Null if the client isn't ready yet (the mention
   *  is then left in the text rather than blocking the message entirely —
   *  same tolerance as discord/handler.ts's botUserId). */
  receivingAgentBotUserId: string | null;
  /** Drizzle DB or transaction object — must support insert/select on these tables. */
  tx: RunnerDeps['db'];
}): Promise<SlackHandleResult> {
  const { message, receivingAgentId, receivingAgentEntityId, receivingAgentBotUserId, tx } = args;

  // Anti ack-loop hard rule — NEVER react to a bot, including ourselves.
  if (message.user.bot) return { skipped: 'bot_author' };

  const text = message.text ?? '';
  if (!text.trim()) return { skipped: 'no_content' };

  const isChannel = message.channelType === 'channel';
  const senderName = sanitizeSenderName(message.user.displayName);
  const conversationId = message.conversationId;
  const kind: 'private' | 'channel' = isChannel ? 'channel' : 'private';

  // H-1 inbound authorization — see channels/shared.ts's checkConversationAuthorization.
  const receiverAuth = await checkConversationAuthorization({
    tx,
    agentId: receivingAgentId,
    entityId: receivingAgentEntityId,
    channel: 'slack',
    conversationId,
    kind,
    senderName,
    allowOwnerClaim: true,
  });
  if (!receiverAuth.authorized) return receiverAuth.result;

  // Channel-kind messages only ever arrive here via `app_mention` — strip the
  // bot's own mention token before deciding what the remaining text means.
  let effectiveText = text;
  if (isChannel) {
    let body = text;
    if (receivingAgentBotUserId) {
      body = body.replace(mentionRegex(receivingAgentBotUserId), '').trim();
    }
    if (!body) return { skipped: 'mention_no_text' };
    effectiveText = body;
  }

  // /ask <slug> <text> routes to a different agent in the same entity.
  let targetAgentId = receivingAgentId;
  let taskText = effectiveText;

  if (effectiveText.startsWith('/ask ')) {
    const parts = effectiveText.slice(5).trim().split(/\s+/);
    const askSlug = parts[0] ?? '';
    const askText = parts.slice(1).join(' ');

    if (!askText) return { skipped: 'ask_no_text' };

    const rows = await tx
      .select({ id: agents.id, name: agents.name })
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

    // F-1 (mirrors discord): the receiving agent's allowlist only authorizes
    // talking to THAT agent — relaying to a sibling is gated by the
    // SIBLING's own allowlist, never bootstrapping it as owner via a relay.
    if (targetAgentId !== receivingAgentId) {
      const targetAuth = await checkConversationAuthorization({
        tx,
        agentId: targetAgentId,
        entityId: receivingAgentEntityId,
        channel: 'slack',
        conversationId,
        kind,
        senderName,
        allowOwnerClaim: false,
        targetAgentName: targetRow.name,
      });
      if (!targetAuth.authorized) return targetAuth.result;
    }
  } else if (isChannel) {
    taskText = `[Message from ${senderName}]: ${effectiveText}`;
  }

  const jobConversationId = await resolveConversationId({
    db: tx,
    entityId: receivingAgentEntityId,
    agentId: targetAgentId,
    channel: 'slack',
    chatId: conversationId,
  });

  const [job] = await tx
    .insert(agentJobs)
    .values({
      entityId: receivingAgentEntityId,
      agentId: targetAgentId,
      channel: 'slack',
      task: taskText,
      chatId: conversationId,
      conversationId: jobConversationId,
      status: 'pending',
      messages: [{ role: 'user', content: taskText }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    // Insert returned no row — the caller's transaction rolls this back; the
    // message is effectively re-deliverable since Slack retries undelivered
    // events, mirroring discord/handler.ts's fail-loud contract.
    throw new Error('slack_job_insert_failed');
  }

  return { jobId: job.id };
}

/**
 * Fire-and-forget triggerWorker. Called by the gateway AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}
