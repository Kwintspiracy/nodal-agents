// channels/whatsapp/handler.ts — turn a WhatsApp inbound message into an
// agent_jobs row. Pure logic, no Baileys/network concerns — mirrors
// channels/discord/handler.ts's shape and H-1 authorization state machine via
// the SAME channel-neutral checkConversationAuthorization (channels/shared.ts;
// whatsapp has no legacy table to dual-write into, exactly like discord/slack).
//
// fromMe/status-broadcast/protocol messages never reach here at all — the
// CORE (packages/delivery's socket-manager.ts mapInboundMessage) already
// filters them out before ever emitting `message`, and WhatsAppInboundMessage
// carries no author/bot flag to re-check — unlike Discord/Slack's neutral
// message shapes, there is nothing left here to defensively re-verify.
//
// Groups: Baileys delivers EVERY group message — there is no platform-level
// mention gate the way Slack's app_mention event provides. This handler is
// therefore the ONLY mention gate WhatsApp gets: only a message that
// @mentions this bot (`mentionsSelf`, computed by the core from
// contextInfo.mentionedJid) or a bare `/ask <slug> <text>` command is
// processed; anything else in a group is dropped (group_filter), the same
// rule as Discord's guild-channel filter.
//
// Media: deferred this phase (mediaPlaceholder — see socket-manager.ts's file
// header). A captionless media message still creates a job with a
// placeholder task text so the agent isn't silently blind to "someone sent
// something".

import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import type { WhatsAppInboundMessage } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { triggerWorker } from '../../routes/agent.ts';
import {
  resolveConversation,
  openNewConversation,
  touchConversation,
  parseNewConversationCommand,
} from '../../job/conversation-id.ts';
import { sanitizeSenderName, checkConversationAuthorization } from '../shared.ts';

export interface WhatsAppHandleResult {
  /** A job was created — caller should triggerJobWorker after the transaction commits. */
  jobId?: string;
  skipped?:
    | 'no_content'
    | 'group_filter'
    | 'ask_no_text'
    | 'ask_unknown_agent'
    | 'awaiting_authorization'
    | 'no_owner_group';
  /**
   * H-1: an UNKNOWN conversation messaged a bot that already has an owner. No
   * job is created; the manager (after the txn commits) sends the owner a
   * plain-text notice (WhatsApp has no buttons) pointing at the dashboard,
   * and tells the requester it is pending.
   */
  pendingAuth?: {
    conversationRowId: string;
    /** null when this pending row IS the owner claim — decided in the dashboard (CHANNEL-001). */
    ownerConversationId: string | null;
    requesterConversationId: string;
    requesterName: string;
    targetAgentName?: string;
  };
}

/** Placeholder task text for a media message with no caption — media intake
 *  itself is deferred (socket-manager.ts's file header), but the agent must
 *  still see THAT something arrived rather than nothing at all. */
const MEDIA_NO_CAPTION_TEXT =
  "Média WhatsApp reçu (texte ou légende absent — la prise en charge des médias n'est pas encore disponible).";

export async function handleWhatsAppMessage(args: {
  message: WhatsAppInboundMessage;
  receivingAgentId: string;
  receivingAgentEntityId: string;
  /** Drizzle DB or transaction object — must support insert/select on these tables. */
  tx: RunnerDeps['db'];
}): Promise<WhatsAppHandleResult> {
  const { message, receivingAgentId, receivingAgentEntityId, tx } = args;

  const text = message.text ?? '';
  if (!text.trim() && !message.mediaPlaceholder) return { skipped: 'no_content' };

  const senderName = sanitizeSenderName(message.senderName ?? message.senderJid);
  const conversationId = message.conversationId;
  const kind: 'private' | 'group' = message.isGroup ? 'group' : 'private';
  const isCommand = text.startsWith('/ask ');

  // Groups: only a genuine mention or an explicit /ask bypasses the filter —
  // Baileys gives no upstream mention gate (unlike Slack's app_mention).
  if (message.isGroup && !isCommand && !message.mentionsSelf) {
    return { skipped: 'group_filter' };
  }

  // H-1 inbound authorization — see channels/shared.ts's checkConversationAuthorization.
  const receiverAuth = await checkConversationAuthorization({
    tx,
    agentId: receivingAgentId,
    entityId: receivingAgentEntityId,
    channel: 'whatsapp',
    conversationId,
    kind,
    senderName,
    allowOwnerClaim: true,
  });
  if (!receiverAuth.authorized) return receiverAuth.result;

  // /ask <slug> <text> routes to a different agent in the same entity.
  let targetAgentId = receivingAgentId;
  let taskText = text;

  if (isCommand) {
    const parts = text.slice(5).trim().split(/\s+/);
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

    // F-1 (mirrors discord/slack): the receiving agent's allowlist only
    // authorizes talking to THAT agent — relaying to a sibling is gated by
    // the SIBLING's own allowlist, never bootstrapping it as owner via a relay.
    if (targetAgentId !== receivingAgentId) {
      const targetAuth = await checkConversationAuthorization({
        tx,
        agentId: targetAgentId,
        entityId: receivingAgentEntityId,
        channel: 'whatsapp',
        conversationId,
        kind,
        senderName,
        allowOwnerClaim: false,
        targetAgentName: targetRow.name,
      });
      if (!targetAuth.authorized) return targetAuth.result;
    }
  } else if (message.isGroup) {
    taskText = `[Message from ${senderName}]: ${text}`;
  }

  if (!taskText.trim() && message.mediaPlaceholder) {
    taskText = MEDIA_NO_CAPTION_TEXT;
  }

  // La CONVERSATION dont ce message est un tour (P6, migration 0094). `/new`
  // ouvre un fil neuf ; un `/new` nu garde `/new` comme tâche — c'est le message
  // de l'utilisateur, le runner ne fabrique rien à sa place (invariant #2).
  const { opensNew, rest } = parseNewConversationCommand(taskText);
  const threadKey = {
    db: tx,
    entityId: receivingAgentEntityId,
    agentId: targetAgentId,
    channel: 'whatsapp',
    chatId: conversationId,
  };
  const conversation = opensNew
    ? await openNewConversation(threadKey)
    : await resolveConversation(threadKey);
  if (opensNew && rest) taskText = rest;

  const [job] = await tx
    .insert(agentJobs)
    .values({
      entityId: receivingAgentEntityId,
      agentId: targetAgentId,
      channel: 'whatsapp',
      task: taskText,
      chatId: conversationId,
      conversationId: conversation.id,
      // Le projet courant du fil suit le travail dès l'insert.
      projectId: conversation.currentProjectId,
      status: 'pending',
      messages: [{ role: 'user', content: taskText }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    // Insert returned no row — the caller's transaction rolls this back, and
    // Baileys/WhatsApp will re-deliver on the next connection (mirrors
    // discord/slack's fail-loud contract).
    throw new Error('whatsapp_job_insert_failed');
  }

  // La conversation est vivante, et elle prend son nom sur le premier message.
  await touchConversation(tx, conversation.id, taskText);

  return { jobId: job.id };
}

/**
 * Fire-and-forget triggerWorker. Called by the manager AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}
