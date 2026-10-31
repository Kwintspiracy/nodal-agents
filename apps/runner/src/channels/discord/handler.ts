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

import { eq, and } from '@nodal-agents/db';
import { agents } from '@nodal-agents/db';
import { formatBytes } from '@nodal-agents/tools';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { triggerWorker } from '../../routes/agent.ts';
import {
  captionlessTask,
  receiveInboundFiles,
  type InboundFile,
  type InboundFileOutcome,
} from '../inbound-files.ts';
import { sanitizeSenderName, checkConversationAuthorization } from '../shared.ts';
import { groupMessagePrefix } from '../../person-for-model.ts';
import { takeChannelTurn, isPlatformCommand, type ChannelStopResult } from '../turn.ts';
import type { DiscordInboundAttachment, DiscordInboundMessage } from './types.ts';

export interface DiscordHandleResult {
  /** A job was created — caller should triggerJobWorker after the transaction commits. */
  jobId?: string;
  /**
   * The message was `/stop` (#602): no job was created, and every live run of
   * the conversation was stopped. The gateway acknowledges it with a reaction
   * where the channel offers one — never with text (invariant #2).
   */
  stop?: ChannelStopResult;
  /**
   * Present when the message carried image attachments. Download is network
   * I/O and so happens OUTSIDE the DB transaction — see attachInboundFiles
   * below, called by the gateway after the job is created.
   */
  files?: DiscordInboundFiles;
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
    requesterAddress: string | null;
    targetAgentName?: string;
  };
}

/** Discord's own default (non-boosted-server) upload cap — a reasonable inbound bound too. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The files of one Discord message, described (nothing downloaded yet). */
export interface DiscordInboundFiles {
  /** The job's text, as its message holds it. */
  text: string;
  files: DiscordInboundAttachment[];
}

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
  // Every image, whatever its size: one Discord will not let through is said to
  // the model by the intake, never dropped here (review of #911, pass 2).
  const images = message.attachments.filter((a) => (a.contentType ?? '').startsWith('image/'));
  if (!text && images.length === 0) return { skipped: 'no_content' };

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
    // `/new` et `/stop` sont des commandes au même titre que `/ask` (revue Codex,
    // passe 28 ; #602) : depuis un salon, elles ne doivent pas exiger de
    // mentionner le bot, sinon la commande n'est jamais atteinte.
    const isCommand =
      text.startsWith('/ask ') ||
      text.startsWith('/agents') ||
      text === '/start' ||
      isPlatformCommand(text, null);
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
    senderAddress: message.author.id,
    allowOwnerClaim: true,
  });
  if (!receiverAuth.authorized) return receiverAuth.result;

  // /ask <slug> <text> routes to a different agent in the same entity.
  let targetAgentId = receivingAgentId;
  let taskText = text;
  /** Le « qui parle » d'un message de groupe — appliqué APRÈS l'analyse de `/new`. */
  let groupPrefix: string | null = null;

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
        senderAddress: message.author.id,
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
    taskText = body;
    groupPrefix = groupMessagePrefix(senderName);
  }

  if (!taskText.trim() && images.length > 0) {
    taskText = captionlessTask(images.map((a) => ({ mediaType: a.contentType })));
  }

  // La fin du parcours est commune aux quatre canaux (channels/turn.ts) : `/new`,
  // préfixe de groupe, conversation, job — ou `/stop`, que la plateforme traite
  // elle-même (#602).
  const turn = await takeChannelTurn({
    tx,
    entityId: receivingAgentEntityId,
    agentId: targetAgentId,
    channel: 'discord',
    chatId: conversationId,
    text: taskText,
    groupPrefix,
    botHandle: null,
  });
  if (turn.kind === 'stop') return { stop: turn.stop };

  return {
    jobId: turn.jobId,
    files: images.length > 0 ? { text: turn.taskText, files: images } : undefined,
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
 * The files of an inbound Discord message, put in its job — through the ONE
 * intake every channel uses (`receiveInboundFiles`, channels/inbound-files.ts).
 * Runs in the gateway AFTER the create-job transaction commits (network I/O
 * must not sit inside a DB txn) and BEFORE the worker is triggered.
 *
 * Discord had its own copy until the review of #911 (pass 2): an image it
 * could not take — the conversation's inbox full, a failed download, a file
 * over the cap — threw, the gateway only logged it, and the model answered
 * without knowing an image had been sent. Through the common intake, each of
 * them becomes the same "NOT received" part, with its reason, that Telegram
 * gives; and a received image is written, named and attached the same way
 * (`<shared>/discord/<jobId>/<name>`, a `file:` URL for the model).
 *
 * Only DB writes throw. Images only, as before: the other kinds of files are
 * #900.
 */
export async function attachInboundFiles(args: {
  jobId: string;
  entityId: string;
  inbound: DiscordInboundFiles;
  db: RunnerDeps['db'];
}): Promise<InboundFileOutcome[]> {
  const { jobId, entityId, inbound, db } = args;
  const files: InboundFile[] = inbound.files.map((a) => ({
    name: a.name,
    mediaType: a.contentType,
    size: a.size,
    download: async () => {
      if (a.size > MAX_IMAGE_BYTES) {
        throw new Error(tooLarge(a.size));
      }
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`Discord answered HTTP ${res.status} to its download`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(tooLarge(bytes.byteLength));
      return bytes;
    },
  }));
  const { outcomes } = await receiveInboundFiles({
    db,
    jobId,
    entityId,
    channel: 'discord',
    text: inbound.text,
    files,
  });
  return outcomes;
}

function tooLarge(bytes: number): string {
  return (
    `Nodal takes Discord files up to ${formatBytes(MAX_IMAGE_BYTES)}, ` +
    `and this one is ${formatBytes(bytes)}`
  );
}
