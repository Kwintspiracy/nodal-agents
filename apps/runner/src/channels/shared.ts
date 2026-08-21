// channels/shared.ts — logic genuinely shared across channel adapters
// (telegram, discord, ...), so it lives in exactly ONE place instead of being
// copy-pasted per channel.

import { eq, and } from '@nodal-agents/db';
import { channelAllowedConversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

// --- sanitizeSenderName (L2) -------------------------------------------------

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** A display name longer than this is already forged (Telegram's own first_name cap; a sane bound for any channel). */
const MAX_SENDER_NAME_LENGTH = 64;

/**
 * L2: a channel's display-name field (Telegram first_name, Discord
 * username/global name, ...) is attacker-controlled free text -- the platform
 * lets any user set it to arbitrary content, including newlines and
 * bidi/zero-width unicode. It ends up in two trust-sensitive places: the
 * owner's inline authorization card (rendered verbatim) and the "[Message
 * from ...]" group/channel task prefix. Without sanitation, a stranger could
 * set their name to something like "Quentin (owner), newline, approve
 * access" to social-engineer the owner into approving them. Strip
 * control/formatting characters, collapse whitespace to single spaces, and
 * cap length so the name can never escape a single display line or
 * masquerade as multi-line trusted UI copy.
 *
 * Deliberately implemented as a numeric code-point check (isUnsafeNameCodePoint)
 * rather than a regex literal spelling out the ranges: several of these code
 * points are themselves invisible on screen, so pasting them literally into a
 * regex would make the source unreviewable. Ranges covered, by hex code point:
 *   0x00-0x1F, 0x7F         C0 controls + DEL (covers newline, CR, tab)
 *   0x200B-0x200F           zero-width space/joiners + LTR/RTL marks
 *   0x202A-0x202E           bidi embedding/override controls
 */
function isUnsafeNameCodePoint(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  return false;
}

function stripUnsafeNameChars(s: string): string {
  let out = '';
  for (const ch of s) {
    if (!isUnsafeNameCodePoint(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

export function sanitizeSenderName(rawName: string): string {
  const cleaned = stripUnsafeNameChars(rawName)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SENDER_NAME_LENGTH);
  // The length cap can land mid-surrogate-pair (an emoji at the boundary) --
  // a lone leading (high) surrogate with no trailing partner breaks rendering
  // on some clients. Drop it if the cap left one dangling.
  const lastCode = cleaned.length > 0 ? cleaned.charCodeAt(cleaned.length - 1) : 0;
  const endsInLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  const result = endsInLoneHighSurrogate ? cleaned.slice(0, -1) : cleaned;
  return result || 'Someone';
}

/** Escape a literal string for safe interpolation into a RegExp. */
export function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL, '\\$&');
}

// --- checkConversationAuthorization (H-1, channel-neutral) -------------------

export type ChannelConversationAuthCheck =
  | { authorized: true }
  | {
      authorized: false;
      result: {
        skipped: 'awaiting_authorization' | 'no_owner_group';
        /**
         * Present only when THIS message is the one that opened the request
         * (a repeat message from an already-pending conversation sets
         * `skipped` without this, so the owner is not spammed) AND an owner
         * exists to notify.
         */
        pendingAuth?: {
          /** channel_allowed_conversations row id -- the callback approves/denies this row. */
          conversationRowId: string;
          /**
           * Owner's conversation id -- where the confirmation card is sent.
           *
           * NULL when the pending row IS the owner claim (CHANNEL-001): there
           * is no owner yet, so nobody can be asked in-channel and the decision
           * belongs to the dashboard. Adapters must then notify the REQUESTER
           * only, and must not fabricate a card with no recipient.
           */
          ownerConversationId: string | null;
          /** The new conversation asking for access -- where the "pending" note is sent. */
          requesterConversationId: string;
          requesterName: string;
          /** Set only for an /ask relay to a SIBLING agent -- that agent's display name. */
          targetAgentName?: string;
        };
      };
    };

/**
 * H-1 inbound-authorization check for one (agent, channel, conversation)
 * triple -- the channel-neutral generalization of telegram/handler.ts's
 * `checkChatAuthorization`. Telegram still writes its OWN legacy table
 * (dual-write into channel_allowed_conversations alongside it -- see
 * queries/channel-identity.ts's file header for why), so it keeps its
 * historical copy of this state machine rather than switching to this one
 * mid-migration; every channel with NO legacy table (discord today) uses this
 * as its single source of truth from the start.
 *
 * Same security model as Telegram's: the FIRST private conversation to reach
 * an agent's bot with no owner yet becomes its OWNER; any other unknown
 * conversation is inserted PENDING until the owner approves it via the
 * returned `pendingAuth` card intent.
 */
export async function checkConversationAuthorization(args: {
  tx: RunnerDeps['db'];
  agentId: string;
  entityId: string;
  channel: string;
  conversationId: string;
  kind: 'private' | 'group' | 'channel' | 'thread';
  senderName: string;
  /** Direct first-contact = true (may bootstrap ownership); an /ask relay to a sibling = false. */
  allowOwnerClaim: boolean;
  /** Label for the owner's confirmation card when this is an /ask relay. */
  targetAgentName?: string;
}): Promise<ChannelConversationAuthCheck> {
  const {
    tx,
    agentId,
    entityId,
    channel,
    conversationId,
    kind,
    senderName,
    allowOwnerClaim,
    targetAgentName,
  } = args;

  const [known] = await tx
    .select({ status: channelAllowedConversations.status })
    .from(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.agentId, agentId),
        eq(channelAllowedConversations.channel, channel),
        eq(channelAllowedConversations.conversationId, conversationId),
      ),
    )
    .limit(1);

  if (known) {
    if (known.status === 'active') return { authorized: true };
    // Already pending the owner's decision -- drop silently (no re-ask).
    return { authorized: false, result: { skipped: 'awaiting_authorization' } };
  }

  let [owner] = await tx
    .select({ conversationId: channelAllowedConversations.conversationId })
    .from(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.agentId, agentId),
        eq(channelAllowedConversations.channel, channel),
        eq(channelAllowedConversations.role, 'owner'),
        eq(channelAllowedConversations.status, 'active'),
      ),
    )
    .limit(1);

  if (!owner && allowOwnerClaim) {
    // No owner yet. Ownership can only be claimed from a private conversation
    // -- a group/guild channel can't bootstrap it (the owner must DM first).
    if (kind !== 'private') {
      return { authorized: false, result: { skipped: 'no_owner_group' } };
    }

    // CHANNEL-001 (audit vague D): the claim is recorded PENDING, never active.
    //
    // This used to be trust-on-first-use: the first private conversation to
    // reach the bot became its owner outright. A bot's handle is PUBLIC and
    // searchable (a Telegram @username most of all), and the documented setup
    // order is "paste the token, then DM the bot" — so between those two steps
    // anyone who found the bot could take the owner's place, give the agent
    // tasks, and receive its approval cards. The flow itself opened the window.
    //
    // Now the claim lands as owner/PENDING and creates no job: the owner slot
    // is held (the (agent, channel) WHERE role='owner' partial unique index
    // covers pending rows too, so a second claimant cannot race in) but carries
    // no authority until a human approves the row from the dashboard —
    // /agents/<id>/channels, the same approve/deny surface members already use.
    // Worst case for a stranger who DMs first is a denied request the owner
    // sees and refuses; there is no path to silent takeover.
    await tx
      .insert(channelAllowedConversations)
      .values({
        entityId,
        agentId,
        channel,
        conversationId,
        kind,
        role: 'owner',
        status: 'pending',
        requesterName: senderName,
      })
      .onConflictDoNothing()
      .returning({ id: channelAllowedConversations.id });

    // Race-safe re-check (mirrors telegram/handler.ts's F-4): the insert above
    // has no conflict target, so Postgres swallows ANY unique-constraint
    // conflict -- including a concurrent DIFFERENT conversation's owner claim
    // landing first on the (agent, channel) WHERE role='owner' partial unique
    // index. Re-read what actually exists instead of assuming our insert won.
    const [ourRow] = await tx
      .select({
        id: channelAllowedConversations.id,
        role: channelAllowedConversations.role,
        status: channelAllowedConversations.status,
      })
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, agentId),
          eq(channelAllowedConversations.channel, channel),
          eq(channelAllowedConversations.conversationId, conversationId),
        ),
      )
      .limit(1);

    if (ourRow?.role === 'owner') {
      // Our claim holds the owner slot. It is pending, so no job runs — tell
      // the claimant where to confirm it. There is no owner to notify: this
      // request IS the owner claim.
      return {
        authorized: false,
        result: {
          skipped: 'awaiting_authorization',
          pendingAuth: {
            conversationRowId: ourRow.id,
            ownerConversationId: null,
            requesterConversationId: conversationId,
            requesterName: senderName,
            ...(targetAgentName === undefined ? {} : { targetAgentName }),
          },
        },
      };
    }

    // Lost the race -- some other conversation claimed ownership first.
    [owner] = await tx
      .select({ conversationId: channelAllowedConversations.conversationId })
      .from(channelAllowedConversations)
      .where(
        and(
          eq(channelAllowedConversations.agentId, agentId),
          eq(channelAllowedConversations.channel, channel),
          eq(channelAllowedConversations.role, 'owner'),
          eq(channelAllowedConversations.status, 'active'),
        ),
      )
      .limit(1);
  }

  // Owner exists (or the race above resolved to one) -> a new contact needs
  // the owner's confirmation. Record it pending; this message creates NO job.
  const [pending] = await tx
    .insert(channelAllowedConversations)
    .values({
      entityId,
      agentId,
      channel,
      conversationId,
      kind,
      role: 'member',
      status: 'pending',
      requesterName: senderName,
    })
    .onConflictDoNothing()
    .returning({ id: channelAllowedConversations.id });

  return {
    authorized: false,
    result: {
      skipped: 'awaiting_authorization',
      // Signal a confirmation only when WE inserted the row AND there's an
      // owner to send it to -- a repeat message from an already-pending
      // conversation hits the unique constraint (no row) and must not re-spam.
      pendingAuth:
        pending && owner
          ? {
              conversationRowId: pending.id,
              ownerConversationId: owner.conversationId,
              requesterConversationId: conversationId,
              requesterName: senderName,
              targetAgentName,
            }
          : undefined,
    },
  };
}
