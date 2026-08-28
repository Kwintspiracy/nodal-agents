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

import { createHash } from 'node:crypto';
import { eq, and, or } from 'drizzle-orm';
import { decrypt, encrypt, isEncrypted } from '@nodal-agents/secrets';
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
 * Decrypt a secret column that may still hold a legacy PLAINTEXT value.
 *
 * Encrypted-at-rest for channel secrets landed on 2026-08-28, long after the
 * columns shipped, so both shapes exist in the wild until every runner has
 * booted once through migratePlaintextSecretsToEncrypted. `isEncrypted` tells
 * them apart by the `enc:v1:` envelope — a bot token can never collide with
 * it (Telegram's is `\d+:[A-Za-z0-9_-]+`, Slack's starts `xoxb-`/`xapp-`,
 * Discord's is base64url with no colon-delimited prefix).
 *
 * A blob that IS encrypted but fails to decrypt throws — see the callers'
 * contract in getBindingCredentials: "wrong master key" must never be
 * flattened into the same `null` that means "no bot configured here".
 */
export function decryptChannelSecret(raw: string, what: string): string {
  if (!isEncrypted(raw)) return raw;
  try {
    return decrypt(raw);
  } catch (err) {
    throw new Error(
      `failed to decrypt ${what}: ${err instanceof Error ? err.message : String(err)}. ` +
        'The master key at ~/.nodalai/secrets.key does not match the one this row ' +
        'was written with (restored backup? copied database?). Re-enter the credential ' +
        'from the dashboard to re-encrypt it under the current key.',
    );
  }
}

/**
 * Serialize + encrypt a credential bag for `channel_bindings.credentials`.
 *
 * The ONE way to write that column. Every channel writer goes through it so a
 * new channel cannot quietly ship a plaintext row the way Telegram, Discord
 * and Slack each did — the previous code called `JSON.stringify` inline at
 * five separate sites, and all five stored the token in the clear.
 */
export function encryptChannelCredentials(creds: Record<string, string>): string {
  return encrypt(JSON.stringify(creds));
}

/**
 * Encrypt a single secret STRING for a legacy scalar column
 * (agents.telegram_bot_token). Idempotent: an already-encrypted value is
 * returned untouched, so a caller that re-saves a row it just read cannot
 * double-wrap the envelope.
 */
export function encryptChannelSecret(plaintext: string): string {
  return isEncrypted(plaintext) ? plaintext : encrypt(plaintext);
}

/**
 * A stable fingerprint of a credential bag, used by the channel managers to
 * detect "the token was rotated → respawn the socket".
 *
 * MUST be computed on the PLAINTEXT, never on the stored blob: AES-GCM draws
 * a fresh random IV per encryption, so re-encrypting the very same token
 * yields different ciphertext every time. Hashing the ciphertext would make
 * each 30s refresh look like a rotation and tear down every live socket in a
 * loop. Keys are sorted so a writer that reorders the JSON bag doesn't read
 * as a rotation either.
 */
export function credentialsFingerprint(creds: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(creds)
      .sort()
      .map((k) => [k, creds[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
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
 * channel_bindings.credentials.
 *
 * Both shapes are decrypted through decryptChannelSecret above. The old file
 * header claimed this package must not import @nodal-agents/secrets; that was
 * never true (queries/credentials.ts has imported it since the OAuth brique,
 * and package.json declares the dependency) and it is the reason these tokens
 * sat in the clear through a real leak.
 *
 * Returns null when there is no credential to send with (no token / no
 * binding / unparseable credentials) — callers treat that as "can't deliver",
 * never as a reason to guess or fall back to a different channel. It THROWS,
 * by contrast, when a credential exists but cannot be decrypted: that is a
 * broken install, not an unconfigured agent, and silently returning null
 * would send the caller down the "no bot here" path (invariant #4).
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
    if (!row?.botToken) return null;
    return {
      botToken: decryptChannelSecret(row.botToken, `telegram bot token (agent ${agentId})`),
    };
  }

  const binding = await getChannelBinding(db, agentId, channel);
  if (!binding) return null;
  const json = decryptChannelSecret(
    binding.credentials,
    `${channel} credentials (agent ${agentId})`,
  );
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Count of ACTIVE conversations (owner + approved members) for (agent,
 * channel) — feeds the system prompt's "Messaging channels" block so an agent
 * knows how many conversations it can already reach on each connected
 * platform, without any network/adapter call. channel='telegram' reads the
 * legacy telegram_allowed_chats table (see file header); every other channel
 * reads channel_allowed_conversations.
 */
export async function countActiveConversations(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
): Promise<number> {
  if (channel === 'telegram') {
    const rows = await db
      .select({ id: telegramAllowedChats.id })
      .from(telegramAllowedChats)
      .where(
        and(eq(telegramAllowedChats.agentId, agentId), eq(telegramAllowedChats.status, 'active')),
      );
    return rows.length;
  }

  const rows = await db
    .select({ id: channelAllowedConversations.id })
    .from(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.agentId, agentId),
        eq(channelAllowedConversations.channel, channel),
        eq(channelAllowedConversations.status, 'active'),
      ),
    );
  return rows.length;
}

/** One allowlist row, channel-neutral shape — see listAllowedConversations. */
export interface AllowedConversationSummary {
  conversationId: string;
  kind: string;
  role: string;
  status: string;
  requesterName: string | null;
}

/**
 * Every allowlist row (owner + pending + approved member) for (agent,
 * channel) — powers `list_conversations`' Telegram path (Telegram bots can't
 * enumerate the chats that have messaged them, so this allowlist IS the
 * agent's complete view of that channel — see file header) and the merge step
 * for channels with real adapter-side discovery.
 *
 * channel='telegram' reads the legacy telegram_allowed_chats table (see file
 * header); that table has no `kind` column of its own, so it is derived from
 * the chat id's sign — Telegram's Bot API convention: group/supergroup/channel
 * ids are negative, private chat ids are positive. Every other channel reads
 * channel_allowed_conversations, which stores `kind` directly.
 */
export async function listAllowedConversations(
  db: AnyDrizzleDb,
  agentId: string,
  channel: string,
): Promise<AllowedConversationSummary[]> {
  if (channel === 'telegram') {
    const rows = await db
      .select({
        conversationId: telegramAllowedChats.chatId,
        role: telegramAllowedChats.role,
        status: telegramAllowedChats.status,
        requesterName: telegramAllowedChats.requesterName,
      })
      .from(telegramAllowedChats)
      .where(eq(telegramAllowedChats.agentId, agentId));
    return rows.map((r) => ({
      ...r,
      kind: r.conversationId.startsWith('-') ? 'group' : 'private',
    }));
  }

  return db
    .select({
      conversationId: channelAllowedConversations.conversationId,
      kind: channelAllowedConversations.kind,
      role: channelAllowedConversations.role,
      status: channelAllowedConversations.status,
      requesterName: channelAllowedConversations.requesterName,
    })
    .from(channelAllowedConversations)
    .where(
      and(
        eq(channelAllowedConversations.agentId, agentId),
        eq(channelAllowedConversations.channel, channel),
      ),
    );
}
