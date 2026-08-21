// channels/discord/handler.ts — turn a Discord inbound message into an
// agent_jobs row. Pure logic, no discord.js/network concerns — mirrors
// telegram/handler.ts's shape and H-1 authorization state machine, but
// generalized via channels/shared.ts's checkConversationAuthorization
// (channel-neutral: discord has no legacy table to dual-write into, unlike
// telegram — see shared.ts's file header for why telegram keeps its own copy).
//
// Bot-author messages are ALWAYS ignored — hard rule against ack-loops (a
// bot's own messages, or another bot's, must never spawn a job). Checked
// first, before anything else touches the DB.
//
// Guild-channel triggers — the bot only reacts when clearly addressed:
//   - `/ask <slug> <text>`          → route to a different agent in the entity
//   - `@bot ...` (a real mention)   → mention
//   - reply to a previous bot msg   → continuation
// Anything else in a guild channel is ignored (group_filter), same rule as
// telegram's group chats.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { workspacesRoot } from '../../lib/workspaces-root.ts';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { triggerWorker } from '../../routes/agent.ts';
import { resolveConversationId } from '../../job/conversation-id.ts';
import { pruneTelegramWorkspace } from '../../telegram/handler.ts';
import { sanitizeSenderName, checkConversationAuthorization } from '../shared.ts';
import type { DiscordInboundMessage } from './types.ts';

export interface DiscordHandleResult {
  /** A job was created — caller should triggerJobWorker after the transaction commits. */
  jobId?: string;
  /**
   * Present when the message carried an eligible image attachment. Download is
   * network I/O and so happens OUTSIDE the DB transaction — see
   * attachInboundImage below, called by the gateway after the job is created.
   */
  attachment?: { url: string; contentType: string; size: number; channelId: string; text: string };
  skipped?:
    | 'bot_author'
    | 'no_content'
    | 'group_filter'
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
    /** null when this pending row IS the owner claim — decided in the dashboard (CHANNEL-001). */
    ownerConversationId: string | null;
    requesterConversationId: string;
    requesterName: string;
    targetAgentName?: string;
  };
}

/** Discord's own default (non-boosted-server) upload cap — a reasonable inbound bound too. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function handleDiscordMessage(args: {
  message: DiscordInboundMessage;
  receivingAgentId: string;
  receivingAgentEntityId: string;
  /** This bot's own Discord user id — required to detect mentions/replies. Null if the client isn't ready yet (mention/reply triggers are then skipped, same tolerance as telegram's botUsername). */
  receivingAgentBotUserId: string | null;
  /** Drizzle DB or transaction object — must support insert/select on these tables. */
  tx: RunnerDeps['db'];
}): Promise<DiscordHandleResult> {
  const { message, receivingAgentId, receivingAgentEntityId, receivingAgentBotUserId, tx } = args;

  // Anti ack-loop hard rule — NEVER react to a bot, including ourselves.
  if (message.author.bot) return { skipped: 'bot_author' };

  const text = message.content ?? '';
  const imageAttachment = message.attachments.find((a) =>
    (a.contentType ?? '').startsWith('image/'),
  );
  if (!text && !imageAttachment) return { skipped: 'no_content' };

  const isGuild = message.channelType === 'guild_text';
  const senderName = sanitizeSenderName(message.author.globalName ?? message.author.username);

  // mentionsSelf (gateway-computed) also covers the bot's guild-managed ROLE
  // mention (`<@&roleId>`) — what Discord's autocomplete actually inserts when
  // a human types `@BotName`. Fallback for legacy callers/fixtures: users-only.
  const isMention =
    message.mentionsSelf ??
    (receivingAgentBotUserId !== null &&
      message.mentionedUserIds.includes(receivingAgentBotUserId));
  const replyToBot =
    receivingAgentBotUserId !== null &&
    message.referencedMessageAuthorId === receivingAgentBotUserId;

  // Guild channel: only respond to commands, mentions, or replies to the bot.
  if (isGuild) {
    const isCommand = text.startsWith('/ask ') || text.startsWith('/agents') || text === '/start';
    if (!isCommand && !isMention && !replyToBot) return { skipped: 'group_filter' };
  }

  const conversationId = message.channelId;
  const kind: 'private' | 'channel' = isGuild ? 'channel' : 'private';

  // H-1 inbound authorization — see channels/shared.ts's checkConversationAuthorization.
  const receiverAuth = await checkConversationAuthorization({
    tx,
    agentId: receivingAgentId,
    entityId: receivingAgentEntityId,
    channel: 'discord',
    conversationId,
    kind,
    senderName,
    allowOwnerClaim: true,
  });
  if (!receiverAuth.authorized) return receiverAuth.result;

  // /ask <slug> <text> routes to a different agent in the same entity.
  let targetAgentId = receivingAgentId;
  let taskText = text;

  if (text.startsWith('/ask ')) {
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

    // F-1 (mirrors telegram): the receiving agent's allowlist only authorizes
    // talking to THAT agent — relaying to a sibling is gated by the
    // SIBLING's own allowlist, never bootstrapping it as owner via a relay.
    if (targetAgentId !== receivingAgentId) {
      const targetAuth = await checkConversationAuthorization({
        tx,
        agentId: targetAgentId,
        entityId: receivingAgentEntityId,
        channel: 'discord',
        conversationId,
        kind,
        senderName,
        allowOwnerClaim: false,
        targetAgentName: targetRow.name,
      });
      if (!targetAuth.authorized) return targetAuth.result;
    }
  } else if (isGuild) {
    let body = text;
    if (isMention) {
      // Strip exactly the tokens that refer to THIS bot (user and/or its
      // managed role) — other users' mentions stay, they can be meaningful
      // content ("demande à <@bob>").
      const tokens =
        message.selfMentionTokens ??
        (receivingAgentBotUserId !== null
          ? [`<@${receivingAgentBotUserId}>`, `<@!${receivingAgentBotUserId}>`]
          : []);
      for (const token of tokens) body = body.split(token).join('');
      body = body.trim();
      if (!body) return { skipped: 'mention_no_text' };
    }
    taskText = `[Message from ${senderName}]: ${body}`;
  }

  if (!taskText.trim() && imageAttachment) {
    taskText = 'Image envoyée (sans légende).';
  }

  const jobConversationId = await resolveConversationId({
    db: tx,
    entityId: receivingAgentEntityId,
    agentId: targetAgentId,
    channel: 'discord',
    chatId: conversationId,
  });

  const [job] = await tx
    .insert(agentJobs)
    .values({
      entityId: receivingAgentEntityId,
      agentId: targetAgentId,
      channel: 'discord',
      task: taskText,
      chatId: conversationId,
      conversationId: jobConversationId,
      status: 'pending',
      messages: [{ role: 'user', content: taskText }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    // Insert returned no row — the caller's transaction rolls this back, and
    // the message is effectively re-deliverable (discord.js doesn't have a
    // cursor to retry from, but this mirrors telegram's fail-loud contract).
    throw new Error('discord_job_insert_failed');
  }

  return {
    jobId: job.id,
    attachment:
      imageAttachment && imageAttachment.size <= MAX_IMAGE_BYTES
        ? {
            url: imageAttachment.url,
            contentType: imageAttachment.contentType ?? 'application/octet-stream',
            size: imageAttachment.size,
            channelId: conversationId,
            text: taskText,
          }
        : undefined,
  };
}

/**
 * Fire-and-forget triggerWorker. Called by the gateway AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}

/**
 * Download an inbound Discord image attachment and attach it to the job — the
 * Discord analog of telegram/handler.ts's attachInboundPhoto. Runs in the
 * gateway AFTER the create-job transaction commits (network I/O must not sit
 * inside a DB txn) and BEFORE the worker is triggered.
 *
 * Reuses pruneTelegramWorkspace as-is: it only takes a directory + db handle
 * and keys files by `<jobId>.<ext>` — already channel-neutral in behavior,
 * the "telegram" in its name is a naming-only artifact of where it was first
 * written. Renaming it to a channel-neutral name is cleanup-phase work, not
 * this ticket.
 */
export async function attachInboundImage(args: {
  jobId: string;
  entityId: string;
  attachment: { url: string; contentType: string; size: number; channelId: string; text: string };
  db: RunnerDeps['db'];
}): Promise<string> {
  const { jobId, entityId, attachment, db } = args;

  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(`discord_image_fetch_failed: HTTP ${res.status} from ${attachment.url}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `discord_image_too_large: ${buf.byteLength} bytes exceeds cap of ${MAX_IMAGE_BYTES} bytes`,
    );
  }

  // Mirrors telegram's shared workspace layout: <workspacesRoot>/<entityId>/shared/<channel>/<conversationId>/<jobId>.<ext>
  const dir = join(workspacesRoot(), entityId, 'shared', 'discord', attachment.channelId);
  await mkdir(dir, { recursive: true });
  const ext = extFromContentType(attachment.contentType);
  const filePath = join(dir, `${jobId}.${ext}`);
  await writeFile(filePath, buf);

  // Conditional on the job still being `pending` (mirrors telegram's TOCTOU
  // guard, audit followup G1): the download is out-of-txn network I/O; in
  // that window the worker (or a cron pickup) can claim the job. Guarding on
  // `pending` makes claim win — we log loudly rather than silently clobber.
  const attached = await db
    .update(agentJobs)
    .set({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: attachment.text },
            { type: 'image', image: filePath },
          ],
        },
      ],
    })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'pending')))
    .returning({ id: agentJobs.id });

  if (attached.length === 0) {
    console.warn(
      `[discord] inbound image for job ${jobId} arrived after the job left 'pending' ` +
        `(claimed/worker started); image saved to ${filePath} but not attached to the transcript.`,
    );
  }

  await pruneTelegramWorkspace(dir, db).catch((err) => {
    console.warn(
      `[discord] workspace prune failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  return filePath;
}

function extFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[contentType] ?? 'bin';
}
