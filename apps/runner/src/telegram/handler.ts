// telegram/handler.ts — turn a Telegram update into an agent_jobs row.
//
// Pure logic, no HTTP or polling concerns. The poller calls handleTelegramUpdate
// inside a transaction that also advances the agent's `telegram_offset` cursor,
// so a crash mid-update doesn't drop the message OR create a duplicate job.
//
// Group chat triggers — the bot only reacts when the user clearly addressed it:
//   - `/ask <slug> <text>`         → route to a different agent in the entity
//   - `/agents` or `/start`        → reserved commands
//   - `@bot_username ...`          → mention with the bot's username
//   - reply to a previous bot msg  → continuation
// Anything else in a group is ignored to avoid the bot replying to every line.

import { writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { workspacesRoot } from '../lib/workspaces-root.ts';
import { eq, and, inArray } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  telegramAllowedChats,
  channelAllowedConversations,
} from '@nodal-agents/db';
import { getTelegramFile, type TelegramUpdate } from '@nodal-agents/delivery';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { triggerWorker } from '../routes/agent.ts';
import { TERMINAL_STATUSES } from '../job/state.ts';
import { resolveConversationId } from '../job/conversation-id.ts';
import { sanitizeSenderName, escapeRegex } from '../channels/shared.ts';

export interface HandleResult {
  /** A job was created — caller should triggerWorker after txn commits. */
  jobId?: string;
  /**
   * Present when the message carried a photo. The DOWNLOAD is network I/O, so it
   * must happen OUTSIDE this DB transaction: the poller takes this, downloads the
   * file, saves it to the shared workspace (telegram/<chatId>/<jobId>.<ext>), and
   * upgrades the job to a multimodal [text + image] message — all before it
   * triggers the worker.
   */
  photo?: { fileId: string; chatId: string; text: string };
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
    /** Owner's chat id — where the confirmation card is sent. */
    ownerChatId: string;
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

  // Telegram sends photo sizes in ascending order; the last is the highest res.
  const largestPhoto =
    Array.isArray(message.photo) && message.photo.length > 0
      ? message.photo[message.photo.length - 1]
      : undefined;
  const hasPhoto = largestPhoto !== undefined;

  // Skip only when there is NEITHER text NOR a photo (sticker / service message).
  if ((!text && !hasPhoto) || chatId === undefined) return { skipped: 'no_text' };

  const isGroup = chatType === 'group' || chatType === 'supergroup';

  // Detect a mention of the bot. F-2: a plain substring match would trigger
  // bot `@news` on `@newsroom hello` — buildMentionRegex requires the
  // username to end at a Telegram-username word boundary ([A-Za-z0-9_]),
  // matching exactly `@news` and not a prefix of a longer handle.
  const isMention =
    receivingAgentBotUsername !== null && buildMentionRegex(receivingAgentBotUsername).test(text);

  // Group chat: only respond to commands, mentions, or replies to the bot.
  if (isGroup) {
    const isCommand = text.startsWith('/ask ') || text.startsWith('/agents') || text === '/start';
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
      if (!body) return { skipped: 'mention_no_text' };
    }
    taskText = `[Message from ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}]: ${body}`;
  }

  // A photo with no caption still becomes a job — give it a neutral task so the
  // agent has context alongside the image (the poller attaches the image next).
  if (!taskText.trim() && hasPhoto) {
    taskText = 'Image envoyée (sans légende).';
  }

  // Jobs page grouping (migration 0059): stamp the same conversation_id as
  // the thread this message continues, using the identical session-gap rule
  // loadThreadHistory already applies for chat continuity — see
  // job/conversation-id.ts. Keyed on targetAgentId (not receivingAgentId):
  // a `/ask <slug>` message routes this job to a different agent, and that
  // agent's own thread is what it belongs to.
  const conversationId = await resolveConversationId({
    db: tx,
    entityId: receivingAgentEntityId,
    agentId: targetAgentId,
    channel: 'telegram',
    chatId: String(chatId),
  });

  const [job] = await tx
    .insert(agentJobs)
    .values({
      entityId: receivingAgentEntityId,
      agentId: targetAgentId,
      channel: 'telegram',
      task: taskText,
      chatId: String(chatId),
      conversationId,
      status: 'pending',
      // Text-only at insert; when there's a photo the poller upgrades this to a
      // multimodal [text + image] message after downloading the file.
      messages: [{ role: 'user', content: taskText }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    // Insert returned no row — the caller's transaction will roll this back
    // and the offset won't advance, so the next poll re-delivers this update.
    throw new Error('telegram_job_insert_failed');
  }

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
    jobId: job.id,
    photo: largestPhoto
      ? { fileId: largestPhoto.file_id, chatId: String(chatId), text: taskText }
      : undefined,
  };
}

/**
 * Fire-and-forget triggerWorker. Called by the poller AFTER the transaction
 * commits, so we don't trigger a worker for a job that got rolled back.
 */
export function triggerJobWorker(jobId: string, env: RunnerEnv): void {
  void triggerWorker(jobId, env);
}

/**
 * Download an inbound Telegram photo and attach it to the job. Runs in the poller
 * AFTER the create-job transaction commits (network I/O must not sit inside a DB
 * txn), and BEFORE the worker is triggered (so it sees the complete job).
 *
 * The image is saved to the entity's SHARED workspace at
 *   <shared>/telegram/<chatId>/<jobId>.<ext>
 * — persistent, traceable, and reachable by the agent's `file_*` tools and by any
 * sub-agent it delegates to. The job's single user message is upgraded from
 * text-only to multimodal `[text, image]`, with the image stored as its absolute
 * path; executeJob hydrates that path into actual bytes for the LLM call (so the
 * messages JSONB stays lean — no base64 in the DB).
 *
 * Best-effort by contract: callers wrap this in try/catch. On failure the job
 * stays text-only and the worker still runs (the agent reports it couldn't load
 * the image rather than silently doing nothing).
 */
export async function attachInboundPhoto(args: {
  jobId: string;
  entityId: string;
  botToken: string;
  photo: { fileId: string; chatId: string; text: string };
  db: RunnerDeps['db'];
}): Promise<string> {
  const { jobId, entityId, botToken, photo, db } = args;

  const download = await getTelegramFile(botToken, photo.fileId);
  // Mirror execute.ts: the shared workspace lives at
  // <workspacesRoot>/<entityId>/shared
  const dir = join(workspacesRoot(), entityId, 'shared', 'telegram', photo.chatId);
  await mkdir(dir, { recursive: true });
  const ext = download.ext === 'bin' ? 'jpg' : download.ext;
  const filePath = join(dir, `${jobId}.${ext}`);
  await writeFile(filePath, download.bytes);

  // Conditional on the job still being `pending` (G1, audit followup). The photo
  // download is out-of-txn network I/O (up to 30s); in that window the worker (or
  // a cron pickup) can claim the job — claimJob flips it pending→processing and
  // starts reading `messages`. An UNCONDITIONAL overwrite here would then clobber
  // the in-flight conversation. Guarding on `pending` makes claim win: if the job
  // already moved on, we do NOT overwrite; we log loudly (never a silent
  // corruption/loss — invariant #4) so the missed image is diagnosable.
  const attached = await db
    .update(agentJobs)
    .set({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: photo.text },
            { type: 'image', image: filePath },
          ],
        },
      ],
    })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'pending')))
    .returning({ id: agentJobs.id });

  if (attached.length === 0) {
    console.warn(
      `[telegram] inbound photo for job ${jobId} arrived after the job left 'pending' ` +
        `(claimed/worker started); image saved to ${filePath} but not attached to the transcript.`,
    );
  }

  // Best-effort, bounded cleanup of this chat's workspace tree (F-13) — without
  // it, `telegram/<chatId>/` grows unbounded forever. A prune failure must never
  // fail the photo attach that already succeeded.
  await pruneTelegramWorkspace(dir, db).catch((err) => {
    console.warn(
      `[telegram] workspace prune failed for ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  return filePath;
}

/** Keep at most this many files per chat's telegram/<chatId>/ directory. */
const TELEGRAM_WORKSPACE_MAX_FILES = 200;
/** Delete files older than this, regardless of the count cap. */
const TELEGRAM_WORKSPACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface PrunableFile {
  path: string;
  /** Parsed from the `<jobId>.<ext>` filename — '' when it doesn't look like one. */
  jobId: string;
  mtimeMs: number;
}

/**
 * Prune a chat's telegram/<chatId>/ image tree: delete anything older than
 * TELEGRAM_WORKSPACE_MAX_AGE_MS, then — if still over the count cap — delete
 * the oldest survivors until back under TELEGRAM_WORKSPACE_MAX_FILES. Runs
 * best-effort on every inbound photo (F-13); a prune failure only logs.
 *
 * NEVER deletes a file whose job hasn't reached a terminal state yet: a job
 * can sit queued behind an approval, a delegation, or plain backlog for a
 * while before `hydrateForLlm` ever reads its inbound image out of the
 * `messages` JSONB. Pruning by raw age/count alone could delete that file out
 * from under a job that hasn't run yet — a silent, unrecoverable image loss.
 * A file whose job no longer exists in the DB at all (purged) has no such
 * risk and stays eligible.
 */
export async function pruneTelegramWorkspace(dir: string, db: RunnerDeps['db']): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);

  const stats = await Promise.all(
    fileNames.map(async (name) => {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        // Filename is `<jobId>.<ext>` (see attachInboundPhoto) — everything
        // before the LAST dot is the id.
        const lastDot = name.lastIndexOf('.');
        const jobId = lastDot > 0 ? name.slice(0, lastDot) : '';
        return { path, jobId, mtimeMs: st.mtimeMs };
      } catch {
        // Deleted concurrently between readdir and stat — ignore.
        return null;
      }
    }),
  );
  let candidates = stats.filter((s): s is PrunableFile => s !== null);

  const jobIds = [...new Set(candidates.map((c) => c.jobId).filter((id) => id.length > 0))];
  if (jobIds.length > 0) {
    const rows = await db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(inArray(agentJobs.id, jobIds));
    const activeJobIds = new Set(
      rows
        .filter((r) => r.status === null || !(TERMINAL_STATUSES as string[]).includes(r.status))
        .map((r) => r.id),
    );
    candidates = candidates.filter((c) => !activeJobIds.has(c.jobId));
  }

  const now = Date.now();
  const stillFresh: typeof candidates = [];
  for (const f of candidates) {
    if (now - f.mtimeMs > TELEGRAM_WORKSPACE_MAX_AGE_MS) {
      await unlink(f.path).catch(() => {});
    } else {
      stillFresh.push(f);
    }
  }
  candidates = stillFresh;

  if (candidates.length > TELEGRAM_WORKSPACE_MAX_FILES) {
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = candidates.length - TELEGRAM_WORKSPACE_MAX_FILES;
    for (const f of candidates.slice(0, excess)) {
      await unlink(f.path).catch(() => {});
    }
  }
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
    await tx
      .insert(telegramAllowedChats)
      .values({
        entityId,
        agentId,
        chatId,
        role: 'owner',
        status: 'active',
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
        status: 'active',
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
      .select({ role: telegramAllowedChats.role, status: telegramAllowedChats.status })
      .from(telegramAllowedChats)
      .where(
        and(eq(telegramAllowedChats.agentId, agentId), eq(telegramAllowedChats.chatId, chatId)),
      )
      .limit(1);

    if (ourRow?.role === 'owner' && ourRow.status === 'active') {
      // Fall through: the owner's own first message proceeds to a job.
      return { authorized: true };
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
