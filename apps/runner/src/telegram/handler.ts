// telegram/handler.ts — turn a Telegram update into an agent_jobs row.
//
// Pure logic, no HTTP or polling concerns. The poller calls handleTelegramUpdate
// inside a transaction that also advances the agent's `telegram_offset` cursor,
// so a crash mid-update doesn't drop the message OR create a duplicate job.
//
// Group chat triggers — the bot only reacts when the user clearly addressed it:
//   - `/ask <slug> <text>`         → route to a different agent in the entity
//   - `/agents` or `/start`        → reserved commands
//   - `/new`, `/stop` (or `/stop@bot`) → platform commands (channels/turn.ts)
//   - `@bot_username ...`          → mention with the bot's username
//   - reply to a previous bot msg  → continuation
// Anything else in a group is ignored to avoid the bot replying to every line.

import { formatBytes } from '@nodal-agents/tools';
import { eq, and } from '@nodal-agents/db';
import { agents, telegramAllowedChats, channelAllowedConversations } from '@nodal-agents/db';
import {
  getTelegramFile,
  TELEGRAM_MAX_FILE_BYTES,
  type TelegramFileRef,
  type TelegramUpdate,
} from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from '../routes/agent.ts';
import { sanitizeSenderName, escapeRegex } from '../channels/shared.ts';
import { groupMessagePrefix } from '../person-for-model.ts';
import { takeChannelTurn, isPlatformCommand, type ChannelStopResult } from '../channels/turn.ts';
import {
  captionlessTask,
  receiveInboundFiles,
  type InboundFile,
  type InboundFileOutcome,
} from '../channels/inbound-files.ts';

export interface HandleResult {
  /** A job was created — caller should triggerWorker after txn commits. */
  jobId?: string;
  /**
   * The message was `/stop` (#602): no job was created, and every live run of
   * the conversation was stopped. The poller acknowledges it with a reaction on
   * the message — never with text (invariant #2).
   */
  stop?: ChannelStopResult;
  /**
   * Present when the message carried a file (photo, document, audio, voice,
   * video, video note, animation — #899). The DOWNLOAD is network I/O, so it
   * must happen OUTSIDE this DB transaction: the poller hands this to
   * attachInboundFiles, which saves each file in the shared workspace and
   * writes the job's message (channels/inbound-files.ts) — all before it
   * triggers the worker.
   */
  files?: TelegramInboundFiles;
  /** The update was filtered out. */
  skipped?:
    | 'no_message'
    | 'no_text'
    | 'group_filter'
    | 'ask_no_text'
    | 'ask_unknown_agent'
    | 'mention_no_text'
    | 'awaiting_authorization'
    | 'no_owner_group';
  /**
   * H-1: an UNKNOWN chat messaged a bot that already has an owner. No job is
   * created; instead the poller (after the txn commits) sends the owner an
   * inline-button card to allow/deny this chat, and tells the requester it is
   * pending. Present only when THIS message was the one that opened the request
   * (a repeat DM from an already-pending chat sets `skipped` without this, so
   * the owner is not spammed).
   */
  pendingAuth?: {
    /** telegram_allowed_chats row id — the callback approves/denies this row. */
    allowedChatId: string;
    /**
     * Owner's chat id — where the confirmation card is sent.
     *
     * NULL when the pending row IS the owner claim (CHANNEL-001): no owner
     * exists yet, so nobody can be asked in-channel and the decision belongs to
     * the dashboard. The poller must then notify the REQUESTER only.
     */
    ownerChatId: string | null;
    /** The new chat asking for access — where the "pending" note is sent. */
    requesterChatId: string;
    /** Display name for the owner's card. */
    requesterName: string;
    /**
     * F-1: set only when this pending request came from `/ask <slug>` routing
     * to a SIBLING agent — the display name of that target agent, so the
     * owner's card can say which bot access is being requested for (the
     * direct first-contact case leaves this undefined: there's only one bot
     * in play, so it's already unambiguous).
     */
    targetAgentName?: string;
  };
}

/**
 * The files of one Telegram message, described (nothing downloaded yet). No
 * chat id: the folder they land in is keyed by the job, never by the chat
 * (#910), so the intake has no use for it.
 */
export interface TelegramInboundFiles {
  /** The job's text, as its message holds it. */
  text: string;
  files: TelegramFileDescriptor[];
}

export interface TelegramFileDescriptor {
  fileId: string;
  name: string | null;
  mediaType: string | null;
  size: number | null;
}

export async function handleTelegramUpdate(args: {
  update: TelegramUpdate;
  receivingAgentId: string;
  receivingAgentEntityId: string;
  /**
   * The bot's @username (without the @). Required to detect mentions in
   * group chats. Null is tolerated — mention-trigger will be skipped.
   */
  receivingAgentBotUsername: string | null;
  /** Drizzle DB or transaction object — must support insert/select on these tables. */
  tx: RunnerDeps['db'];
}): Promise<HandleResult> {
  const { update, receivingAgentId, receivingAgentEntityId, receivingAgentBotUsername, tx } = args;

  const message = update.message;
  if (!message) return { skipped: 'no_message' };

  // The user's words live in `text` for a plain message, or `caption` when the
  // message carries media (a photo/document). Read both.
  const text = message.text ?? message.caption ?? '';
  const chat = message.chat ?? {};
  const chatId = chat.id;
  const chatType = chat.type ?? 'private';
  const sender = message.from ?? {};
  const senderName = sanitizeSenderName(sender.first_name ?? '');
  const senderUsername = sender.username ?? '';

  const files = telegramFilesOf(message);
  const hasFile = files.length > 0;

  // Skip only when there is NEITHER text NOR a file (sticker / service message).
  if ((!text && !hasFile) || chatId === undefined) return { skipped: 'no_text' };

  const isGroup = chatType === 'group' || chatType === 'supergroup';

  // Detect a mention of the bot. F-2: a plain substring match would trigger
  // bot `@news` on `@newsroom hello` — buildMentionRegex requires the
  // username to end at a Telegram-username word boundary ([A-Za-z0-9_]),
  // matching exactly `@news` and not a prefix of a longer handle.
  const isMention =
    receivingAgentBotUsername !== null && buildMentionRegex(receivingAgentBotUsername).test(text);

  // Group chat: only respond to commands, mentions, or replies to the bot.
  if (isGroup) {
    // `/new` et `/stop` sont des commandes au même titre que `/ask` : dans un groupe,
    // elles doivent passer le filtre sans avoir à mentionner le bot (#602).
    const isCommand =
      text.startsWith('/ask ') ||
      text.startsWith('/agents') ||
      text === '/start' ||
      isPlatformCommand(text, receivingAgentBotUsername);
    // F-2: only a reply to THIS bot's own message counts — a reply to some
    // OTHER bot in the group (a different agent, a poll bot, whatever) must
    // not wake this one up.
    const replyToBotUsername = message.reply_to_message?.from?.username;
    const replyToBot =
      message.reply_to_message?.from?.is_bot === true &&
      receivingAgentBotUsername !== null &&
      replyToBotUsername !== undefined &&
      replyToBotUsername.toLowerCase() === receivingAgentBotUsername.toLowerCase();
    if (!isCommand && !isMention && !replyToBot) return { skipped: 'group_filter' };
  }

  // ── H-1: inbound authorization ──────────────────────────────────────────────
  // A Telegram bot's username is discoverable, so a stranger who DMs it must NOT
  // be able to spawn a job with this agent's tools/connectors. Only chats on the
  // per-bot allowlist may proceed. The FIRST private DM to a bot with no owner
  // claims ownership (the person who set it up); any other unknown chat is held
  // pending and the owner is asked to confirm before it is allowed.
  const chatIdStr = String(chatId);
  const receiverAuth = await checkChatAuthorization({
    tx,
    agentId: receivingAgentId,
    entityId: receivingAgentEntityId,
    chatId: chatIdStr,
    chatType,
    senderName,
    allowOwnerClaim: true,
  });
  if (!receiverAuth.authorized) return receiverAuth.result;
  // Authorized (active member/owner, or ownership just claimed) → continue.

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

    // F-1: the receiving agent's allowlist only authorizes talking to THAT
    // agent — `/ask` re-pointing the job at a sibling must be gated by the
    // SIBLING's own allowlist, or any chat authorized on ANY bot could reach
    // every other agent in the entity by relaying through it. Ownership can
    // only ever be claimed via a direct DM to the target's own bot (never via
    // a relay), so this check never lets the chat become owner here — at
    // most it lands as a pending member, even if the target has no owner yet.
    if (targetAgentId !== receivingAgentId) {
      const targetAuth = await checkChatAuthorization({
        tx,
        agentId: targetAgentId,
        entityId: receivingAgentEntityId,
        chatId: chatIdStr,
        chatType,
        senderName,
        allowOwnerClaim: false,
        targetAgentName: targetRow.name,
      });
      if (!targetAuth.authorized) return targetAuth.result;
    }
  } else if (isGroup) {
    // Group chats: strip the @mention if present so the agent doesn't see
    // its own handle in the prompt; then prefix with sender name so it
    // knows who's speaking.
    let body = text;
    if (isMention) {
      body = body.replace(buildMentionRegex(receivingAgentBotUsername!), '').trim();
      // A file captioned with the mention alone is still a message (#899).
      if (!body && !hasFile) return { skipped: 'mention_no_text' };
    }
    taskText = body;
    groupPrefix = groupMessagePrefix(senderName, senderUsername || null);
  }

  // A file with no caption still becomes a job — give it a neutral task so the
  // agent has context alongside the file (the poller attaches the file next).
  if (!taskText.trim() && hasFile) {
    taskText = captionlessTask(files);
  }

  // La fin du parcours est commune aux quatre canaux (channels/turn.ts) : `/new`,
  // préfixe de groupe, conversation, job — ou `/stop`, que la plateforme traite
  // elle-même (#602). Clé sur targetAgentId (pas receivingAgentId) : un
  // `/ask <slug>` route le message vers un autre agent, et c'est au fil de CET
  // agent qu'il appartient.
  const turn = await takeChannelTurn({
    tx,
    entityId: receivingAgentEntityId,
    agentId: targetAgentId,
    channel: 'telegram',
    chatId: String(chatId),
    text: taskText,
    groupPrefix,
    botHandle: receivingAgentBotUsername,
  });
  if (turn.kind === 'stop') return { stop: turn.stop };

  // Atomically record the last-seen chat_id so the dashboard can offer
  // "send result via Telegram" for this agent. F-3: only for PRIVATE chats —
  // it's display-only, but a group message would otherwise overwrite the
  // owner's own DM chat id with the group's, breaking that dashboard feature.
  if (chatType === 'private') {
    await tx
      .update(agents)
      .set({ lastSeenChatIdTelegram: String(chatId) })
      .where(eq(agents.id, receivingAgentId));
  }

  return {
    jobId: turn.jobId,
    files: hasFile ? { text: turn.taskText, files } : undefined,
  };
}

/**
 * Every file a Telegram message carries, as the intake describes it. Telegram
 * puts each kind in its own field; a message has one file, except that an
 * `animation` ALSO comes as `document` (Bot API, for older clients) — the same
 * file_id, kept once.
 */
function telegramFilesOf(
  message: NonNullable<TelegramUpdate['message']>,
): TelegramFileDescriptor[] {
  // Photo sizes come smallest → largest; the last is the highest resolution.
  // Telegram stores every photo as JPEG and gives it no name.
  const largestPhoto = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
  const photo: TelegramFileRef | undefined = largestPhoto && {
    ...largestPhoto,
    mime_type: 'image/jpeg',
  };
  // A video note is always MP4, and Telegram declares no type for it.
  const videoNote: TelegramFileRef | undefined = message.video_note && {
    mime_type: 'video/mp4',
    ...message.video_note,
  };
  const refs = [
    photo,
    message.animation,
    message.document,
    message.audio,
    message.voice,
    message.video,
    videoNote,
  ];
  const out: TelegramFileDescriptor[] = [];
  for (const ref of refs) {
    if (!ref || out.some((f) => f.fileId === ref.file_id)) continue;
    out.push({
      fileId: ref.file_id,
      name: ref.file_name ?? null,
      mediaType: ref.mime_type ?? null,
      size: ref.file_size ?? null,
    });
  }
  return out;
}

/**
 * Fire-and-forget triggerWorker. Called by the poller AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}

/**
 * Download the files of an inbound Telegram message and put them in the job
 * (channels/inbound-files.ts). Runs in the poller AFTER the create-job
 * transaction commits (network I/O must not sit inside a DB txn), and BEFORE
 * the worker is triggered (so it sees the complete job).
 *
 * The files land in the entity's SHARED workspace at
 *   <shared>/telegram/<jobId>/<original name>
 * — persistent, traceable, and reachable by the agent's `file_*` tools and by any
 * sub-agent it delegates to. No chat id in the path (#910): the model reads the
 * chat id as its handle, and would be shown a path that does not exist. A file the Bot API will not hand a bot (over
 * 20 MB) or that fails to download is said to the agent, never dropped.
 */
export async function attachInboundFiles(args: {
  jobId: string;
  entityId: string;
  botToken: string;
  inbound: TelegramInboundFiles;
  db: RunnerDeps['db'];
}): Promise<InboundFileOutcome[]> {
  const { jobId, entityId, botToken, inbound, db } = args;
  const files: InboundFile[] = inbound.files.map((f) => ({
    name: f.name,
    mediaType: f.mediaType,
    size: f.size,
    download: async () => {
      if (f.size !== null && f.size > TELEGRAM_MAX_FILE_BYTES) {
        throw new Error(
          `Telegram lets a bot download files up to ${formatBytes(TELEGRAM_MAX_FILE_BYTES)}, ` +
            `and this one is ${formatBytes(f.size)}`,
        );
      }
      return (await getTelegramFile(botToken, f.fileId)).bytes;
    },
  }));
  const { outcomes } = await receiveInboundFiles({
    db,
    jobId,
    entityId,
    channel: 'telegram',
    text: inbound.text,
    files,
  });
  return outcomes;
}

// ─── helpers ──────────────────────────────────────────────────────────────────
//
// sanitizeSenderName (L2) moved to ../channels/shared.ts — it is genuinely
// channel-neutral (Discord needs the identical guard against a forged
// display name social-engineering the owner card) and is imported above
// rather than duplicated here.

/**
 * F-2: matches `@botusername` as a whole token — Telegram usernames only
 * contain [A-Za-z0-9_], so a negative lookahead for another such character
 * stops bot `@news` from matching inside `@newsroom hello`.
 */
function buildMentionRegex(botUsername: string): RegExp {
  return new RegExp(`@${escapeRegex(botUsername)}(?![A-Za-z0-9_])`, 'gi');
}

/**
 * Telegram's chat `type` → the channel-neutral `kind` enum
 * (channel_allowed_conversations.kind: 'private'|'group'|'channel'|'thread').
 * Telegram never sends 'thread' at the chat level (topics are a message-level
 * concept there), so only 'private' and 'group'/'supergroup'→'group' are
 * reachable today; 'channel' is included for completeness against Telegram's
 * own chat.type union.
 */
function chatTypeToConversationKind(chatType: string): 'private' | 'group' | 'channel' | 'thread' {
  if (chatType === 'private') return 'private';
  if (chatType === 'channel') return 'channel';
  return 'group';
}

type ChatAuthCheck = { authorized: true } | { authorized: false; result: HandleResult };

/**
 * H-1 inbound-authorization check for one (agent, chat) pair. Shared by two
 * call sites in handleTelegramUpdate:
 *   - the RECEIVING agent (a chat messaging its own bot directly) — may
 *     claim ownership when the bot has none yet (`allowOwnerClaim: true`).
 *   - F-1: the TARGET agent of a `/ask <slug>` relay — a chat authorized to
 *     talk to agent A must not reach agent B just by asking A to relay it, so
 *     B's OWN allowlist is checked too. `allowOwnerClaim: false` here: a
 *     relay is never a direct DM to B's bot, so it can only ever land B as a
 *     pending member — never its owner, even when B has no owner yet.
 */
async function checkChatAuthorization(args: {
  tx: RunnerDeps['db'];
  agentId: string;
  entityId: string;
  chatId: string;
  chatType: string;
  senderName: string;
  allowOwnerClaim: boolean;
  /** F-1: label for the owner's confirmation card when this is an /ask relay. */
  targetAgentName?: string;
}): Promise<ChatAuthCheck> {
  const { tx, agentId, entityId, chatId, chatType, senderName, allowOwnerClaim, targetAgentName } =
    args;

  const [known] = await tx
    .select({ status: telegramAllowedChats.status })
    .from(telegramAllowedChats)
    .where(and(eq(telegramAllowedChats.agentId, agentId), eq(telegramAllowedChats.chatId, chatId)))
    .limit(1);

  if (known) {
    if (known.status === 'active') return { authorized: true };
    // Already pending the owner's decision — drop silently (no re-ask).
    return { authorized: false, result: { skipped: 'awaiting_authorization' } };
  }

  let [owner] = await tx
    .select({ chatId: telegramAllowedChats.chatId })
    .from(telegramAllowedChats)
    .where(
      and(
        eq(telegramAllowedChats.agentId, agentId),
        eq(telegramAllowedChats.role, 'owner'),
        eq(telegramAllowedChats.status, 'active'),
      ),
    )
    .limit(1);

  if (!owner && allowOwnerClaim) {
    // No owner yet. Ownership can only be claimed from a private DM — a group
    // can't bootstrap it (the owner must DM the bot first).
    if (chatType !== 'private') {
      return { authorized: false, result: { skipped: 'no_owner_group' } };
    }
    // CHANNEL-001 (audit vague D): PENDING, never active.
    //
    // This was trust-on-first-use, and Telegram is where it actually bit: a
    // bot's @username is public and globally searchable, and the setup order
    // this product documents is "paste the token, then DM the bot" — so the
    // nominal flow itself opened a window in which any stranger who found the
    // bot could become its owner, task the agent, and receive its approval
    // cards. Slack/Discord are shielded by workspace membership and WhatsApp is
    // the user's own account; Telegram had nothing.
    //
    // The claim now HOLDS the owner slot (the WHERE role='owner' partial unique
    // index covers pending rows) but carries no authority until a human
    // approves it from the dashboard. A stranger DMing first can only produce a
    // request the real owner sees and denies.
    await tx
      .insert(telegramAllowedChats)
      .values({
        entityId,
        agentId,
        chatId,
        role: 'owner',
        status: 'pending',
        requesterName: senderName,
      })
      .onConflictDoNothing();
    // S3 dual-write: mirror the same claim attempt into the channel-neutral
    // table, in the SAME transaction. Its own unique constraints (the
    // 3-column unique + the (agent,channel) WHERE role='owner' partial
    // index — migration 0064, mirroring this table's F-1 fix) resolve the
    // identical race the same way: the winner's mirror insert lands, a
    // loser's silently no-ops via onConflictDoNothing, exactly like the
    // legacy insert above. No re-check needed here — the re-check against
    // telegramAllowedChats below remains the single source of truth this
    // phase (see queries/channel-identity.ts's file header).
    await tx
      .insert(channelAllowedConversations)
      .values({
        entityId,
        agentId,
        channel: 'telegram',
        conversationId: chatId,
        kind: chatTypeToConversationKind(chatType),
        role: 'owner',
        status: 'pending',
        requesterName: senderName,
      })
      .onConflictDoNothing();

    // F-4: race-safe re-check. `.onConflictDoNothing()` above has no target,
    // so Postgres swallows ANY unique-constraint conflict on this table —
    // including a concurrent DIFFERENT chat's owner claim landing first on
    // the (agent_id) WHERE role='owner' partial unique index. Re-read what
    // actually exists for THIS (agent, chat) pair instead of assuming our
    // insert won: in the common single-writer case it did, and this read
    // just confirms that with no behavior change.
    const [ourRow] = await tx
      .select({
        id: telegramAllowedChats.id,
        role: telegramAllowedChats.role,
        status: telegramAllowedChats.status,
      })
      .from(telegramAllowedChats)
      .where(
        and(eq(telegramAllowedChats.agentId, agentId), eq(telegramAllowedChats.chatId, chatId)),
      )
      .limit(1);

    if (ourRow?.role === 'owner') {
      // Our claim holds the owner slot, PENDING (CHANNEL-001) — no job runs.
      // There is no owner to card: this request IS the owner claim, so the
      // decision belongs to the dashboard. Point the claimant at it.
      return {
        authorized: false,
        result: {
          skipped: 'awaiting_authorization',
          pendingAuth: {
            allowedChatId: ourRow.id,
            ownerChatId: null,
            requesterChatId: chatId,
            requesterName: senderName,
            ...(targetAgentName === undefined ? {} : { targetAgentName }),
          },
        },
      };
    }

    // Lost the race — some other chat claimed ownership first. Fall back to
    // pending member below, exactly like the "owner already exists" branch;
    // re-fetch the actual owner so there's someone to notify.
    [owner] = await tx
      .select({ chatId: telegramAllowedChats.chatId })
      .from(telegramAllowedChats)
      .where(
        and(
          eq(telegramAllowedChats.agentId, agentId),
          eq(telegramAllowedChats.role, 'owner'),
          eq(telegramAllowedChats.status, 'active'),
        ),
      )
      .limit(1);
  }

  // Owner exists (or the race above resolved to one) → a new contact needs
  // the owner's confirmation. Record it pending and signal the poller to ask;
  // this message creates NO job. When NO owner exists at all — only reachable
  // via an /ask relay, where allowOwnerClaim is false — there's no one to
  // notify yet, so the chat still lands pending, just silently.
  const [pending] = await tx
    .insert(telegramAllowedChats)
    .values({
      entityId,
      agentId,
      chatId,
      role: 'member',
      status: 'pending',
      requesterName: senderName,
    })
    .onConflictDoNothing()
    .returning({ id: telegramAllowedChats.id });
  // S3 dual-write: mirror the pending-member insert. Same onConflictDoNothing
  // semantics as above — a repeat DM from an already-pending chat no-ops on
  // both tables identically.
  await tx
    .insert(channelAllowedConversations)
    .values({
      entityId,
      agentId,
      channel: 'telegram',
      conversationId: chatId,
      kind: chatTypeToConversationKind(chatType),
      role: 'member',
      status: 'pending',
      requesterName: senderName,
    })
    .onConflictDoNothing();

  return {
    authorized: false,
    result: {
      skipped: 'awaiting_authorization',
      // Signal a confirmation only when WE inserted the row AND there's an
      // owner to send it to — a repeat DM from an already-pending chat hits
      // the unique constraint (no row) and must not re-spam the owner.
      pendingAuth:
        pending && owner
          ? {
              allowedChatId: pending.id,
              ownerChatId: owner.chatId,
              requesterChatId: chatId,
              requesterName: senderName,
              targetAgentName,
            }
          : undefined,
    },
  };
}
