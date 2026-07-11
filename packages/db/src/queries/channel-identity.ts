// queries/channel-identity.ts — channel-neutral identity & authorization (S2).
//
// Generalizes the Telegram H-1 security model (resolveOwnerChatId,
// isChatAllowed — queries/telegram-owner.ts, queries/telegram-allowed.ts) to
// any channel via channel_bindings / channel_allowed_conversations (migration
// 0064) — WITHOUT changing Telegram's current behavior yet.
//
// Transitional read split (S2 only): telegram_allowed_chats is still the
// table the Telegram inbound handler WRITES to (owner-claim, pending-approval
// flow — untouched in this brique). Migration 0064 back-fills its rows into
// channel_allowed_conversations once, but nothing keeps that copy live
// afterward, so reading it for channel='telegram' would silently drift stale
// the moment a new chat DMs a bot. Until S3 flips the Telegram writers to
// dual-write (and a follow-up drops the legacy table), channel='telegram'
// reads go straight to telegram_allowed_chats — every OTHER channel reads the
// neutral table, which is its only source of truth for that channel.

import { eq, and, or } from 'drizzle-orm';
import { telegramAllowedChats } from '../schema/telegram-allowed-chats.ts';
import { channelBindings, type ChannelBindingRow } from '../schema/channel-bindings.ts';
import { channelAllowedConversations } from '../schema/channel-allowed-conversations.ts';
import { agents } from '../schema/agents.ts';
import type { AnyDrizzleDb } from '../client.ts';

/**
 * The active OWNER's conversation id for a given (agent, channel), or null
 * when there is no registered owner yet. channel='telegram' reads the legacy
 * telegram_allowed_chats table (see file header); every other channel reads
 * channel_allowed_conversations.
 */
export async function resolveOwnerConversation(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
): Promise<string | null> {
  if (channel === 'telegram') {
    const [row] = await db
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
    return row?.chatId ?? null;
  }

  const [row] = await db
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
  return row?.conversationId ?? null;
}

/**
 * Whether a (entity, agent, channel, conversation) is an ACTIVE, approved
 * inbound/outbound target — scoped to either the entity OR the agent (a
 * delegated worker inherits its entity ROOT agent's binding). channel='telegram'
 * reads the legacy telegram_allowed_chats table (see file header); every
 * other channel reads channel_allowed_conversations.
 */
export async function isConversationAllowed(
  db: AnyDrizzleDb,
  params: { entityId: string; agentId: string; channel: string; conversationId: string },
): Promise<boolean> {
  if (params.channel === 'telegram') {
    const [row] = await db
      .select({ id: telegramAllowedChats.id })
      .from(telegramAllowedChats)
      .where(
        and(
          eq(telegramAllowedChats.chatId, params.conversationId),
          eq(telegramAllowedChats.status, 'active'),
          or(
            eq(telegramAllowedChats.entityId, params.entityId),
            eq(telegramAllowedChats.agentId, params.agentId),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  const [row] = await db
    .select({ id: channelAllowedConversations.id })
    .from(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.channel, params.channel),
        eq(channelAllowedConversations.conversationId, params.conversationId),
        eq(channelAllowedConversations.status, 'active'),
        or(
          eq(channelAllowedConversations.entityId, params.entityId),
          eq(channelAllowedConversations.agentId, params.agentId),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The credential/identity binding for a given (agent, channel), or null if unbound. */
export async function getChannelBinding(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
): Promise<ChannelBindingRow | null> {
  const [row] = await db
    .select()
    .from(channelBindings)
    .where(and(eq(channelBindings.agentId, agentId), eq(channelBindings.channel, channel)))
    .limit(1);
  return row ?? null;
}

/** Every channel binding configured for a given agent, across all channels. */
export async function listChannelBindings(
  db: AnyDrizzleDb,
  agentId: string,
): Promise<ChannelBindingRow[]> {
  return db.select().from(channelBindings).where(eq(channelBindings.agentId, agentId));
}

/**
 * The credential bag needed to actually SEND on a (agent, channel) pair (S3).
 *
 * channel='telegram' reads `agents.telegram_bot_token` directly — the SAME
 * transitional pattern as resolveOwnerConversation/isConversationAllowed
 * above: migration 0064's channel_bindings back-fill is a one-time copy that
 * nothing keeps live, so reading it here would silently drift stale the
 * moment a token is rotated via the dashboard (which still writes
 * agents.telegram_bot_token, not channel_bindings). Every OTHER channel reads
 * channel_bindings.credentials, JSON-parsed — @nodal-agents/db never imports
 * @nodal-agents/secrets to decrypt (architecture rule: only the writer layer
 * does), so this path is inert until a real non-Telegram channel ships its
 * first live writer with actual encryption-at-rest.
 *
 * Returns null when there is no credential to send with (no token / no
 * binding / unparseable credentials) — callers treat that as "can't deliver",
 * never as a reason to guess or fall back to a different channel.
 */
export async function getBindingCredentials(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
): Promise<Record<string, string> | null> {
  if (channel === 'telegram') {
    const [row] = await db
      .select({ botToken: agents.telegramBotToken })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row?.botToken ? { botToken: row.botToken } : null;
  }

  const binding = await getChannelBinding(db, agentId, channel);
  if (!binding) return null;
  try {
    const parsed: unknown = JSON.parse(binding.credentials);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}
