// channels/discord/auth-callback.ts — resolve an inbound-conversation
// authorization from a Discord button tap (H-1). Mirrors
// telegram/auth-callback.ts, but against the channel-neutral
// channel_allowed_conversations table ONLY — discord has no legacy table to
// dual-write into.

import { eq, and } from '@nodal-agents/db';
import { channelAllowedConversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import type { DiscordInteractionAck } from './types.ts';

/** Button customId prefix for conversation-authorization decisions. */
export const DISCORD_AUTH_CALLBACK_PREFIX = 'dauth';

/** Parse `dauth:<uuid>:<a|d>` → { rowId, decision }, or null if it isn't ours / malformed. */
export function parseDiscordAuthCallbackData(
  customId: string | undefined,
): { rowId: string; decision: 'allow' | 'deny' } | null {
  if (!customId) return null;
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== DISCORD_AUTH_CALLBACK_PREFIX) return null;
  const [, id, d] = parts;
  if (!id || (d !== 'a' && d !== 'd')) return null;
  return { rowId: id, decision: d === 'a' ? 'allow' : 'deny' };
}

export type DiscordAuthInteractionResult =
  | { handled: true; decision: 'allow' | 'deny'; conversationId: string }
  | { handled: false; reason: string };

export async function handleDiscordAuthInteraction(args: {
  parsed: { rowId: string; decision: 'allow' | 'deny' };
  channelId: string;
  channelType: 'dm' | 'guild_text';
  /** The polling agent — the pending row must belong to its own binding. */
  receivingAgentId: string;
  ack: DiscordInteractionAck;
  deps: RunnerDeps;
}): Promise<DiscordAuthInteractionResult> {
  const { parsed, channelId, channelType, receivingAgentId, ack, deps } = args;

  // Authorization decisions are DM-only — mirrors the approval-callback rule:
  // a guild channel has many members who could tap the button; only the
  // owner's own DM with the bot may decide.
  if (channelType !== 'dm') {
    await ack.ephemeralReply('This can only be decided in a DM with the bot.');
    return { handled: false, reason: 'not_dm' };
  }

  const [row] = await deps.db
    .select({
      id: channelAllowedConversations.id,
      agentId: channelAllowedConversations.agentId,
      conversationId: channelAllowedConversations.conversationId,
      status: channelAllowedConversations.status,
      requesterName: channelAllowedConversations.requesterName,
    })
    .from(channelAllowedConversations)
    .where(eq(channelAllowedConversations.id, parsed.rowId))
    .limit(1);

  if (!row) {
    await ack.ephemeralReply('This request no longer exists.');
    return { handled: false, reason: 'auth_row_not_found' };
  }

  // Defense in depth: the tap must arrive on the bot that owns this row.
  if (row.agentId !== receivingAgentId) {
    await ack.ephemeralReply('Not authorized.');
    return { handled: false, reason: 'agent_mismatch' };
  }

  // SECURITY: only the bot's OWNER may decide. Verify the tap came from the
  // owner's own conversation.
  const [owner] = await deps.db
    .select({ conversationId: channelAllowedConversations.conversationId })
    .from(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.agentId, receivingAgentId),
        eq(channelAllowedConversations.channel, 'discord'),
        eq(channelAllowedConversations.role, 'owner'),
        eq(channelAllowedConversations.status, 'active'),
      ),
    )
    .limit(1);

  if (!owner || channelId !== owner.conversationId) {
    await ack.ephemeralReply('Not authorized.');
    return { handled: false, reason: 'not_owner' };
  }

  // Already decided — a double-allow (deny+deletion is covered by the
  // not-found case above).
  if (row.status === 'active') {
    await ack.resolveCard(`✅ ${row.requesterName ?? 'Ce contact'} est déjà autorisé.`);
    return { handled: true, decision: 'allow', conversationId: row.conversationId };
  }

  const who = row.requesterName ?? 'Ce contact';

  if (parsed.decision === 'allow') {
    // Conditional on still-pending so a concurrent decision can't be clobbered.
    await deps.db
      .update(channelAllowedConversations)
      .set({ status: 'active', updatedAt: new Date() })
      .where(
        and(
          eq(channelAllowedConversations.id, row.id),
          eq(channelAllowedConversations.status, 'pending'),
        ),
      );
    await ack.resolveCard(`✅ ${who} est maintenant autorisé à parler à ce bot.`);
    return { handled: true, decision: 'allow', conversationId: row.conversationId };
  }

  // Deny: remove the row so the conversation stays blocked (a future message re-asks).
  await deps.db
    .delete(channelAllowedConversations)
    .where(eq(channelAllowedConversations.id, row.id));
  await ack.resolveCard(`❌ ${who} n'est pas autorisé à parler à ce bot.`);
  return { handled: true, decision: 'deny', conversationId: row.conversationId };
}
