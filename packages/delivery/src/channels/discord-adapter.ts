// channels/discord-adapter.ts — ChannelAdapter implementation for Discord
// (OUTBOUND only — the gateway/websocket ingress lives in apps/runner).
//
// Unlike Telegram (raw fetch, hand-rolled retry/backoff — channels/telegram.ts),
// Discord's official SDK already IS the low-level HTTP layer we need: discord.js's
// REST class (`REST` + `Routes`, both re-exported from `discord.js` — see house
// rule on official SDKs) queues requests per rate-limit bucket and retries 429s
// and 5xx/timeouts internally. There is therefore no separate "channels/discord.ts"
// protocol file the way Telegram has one — this single file IS both the wire
// layer and the ChannelAdapter shape.
//
// A fresh REST client is built per call from the caller-supplied bot token
// (makeRestClient) rather than cached, mirroring Telegram's per-call `fetch` —
// different jobs can carry different entities' bot tokens, so nothing here may
// assume a single long-lived credential.

import {
  REST,
  Routes,
  DiscordAPIError,
  HTTPError,
  RateLimitError,
  AllowedMentionsTypes,
  ButtonStyle,
  ComponentType,
  ChannelType,
} from 'discord.js';
import type {
  APIActionRowComponent,
  APIButtonComponentWithCustomId,
  APIComponentInMessageActionRow,
  APIGuildChannel,
  APIMessage,
  APIUser,
  GuildChannelType,
  RawFile,
  RESTGetAPICurrentUserGuildsResult,
  RESTGetAPIGuildChannelsResult,
  RESTPatchAPIChannelMessageJSONBody,
  RESTPostAPIChannelMessageJSONBody,
} from 'discord.js';
import { DeliveryError } from '../errors.ts';
import type {
  ChannelAdapter,
  ChannelCredentials,
  DiscoveredConversation,
  OutboundMedia,
  ApprovalCard,
  SendResult,
  BotIdentity,
  TextFormat,
} from '../channel-adapter.ts';

/**
 * House security decision: never let agent-authored text ping @everyone/@here
 * or a role, on ANY outbound Discord message (create or edit). `parse: ['users']`
 * still allows direct user mentions/replies through — only the mass-ping vectors
 * are blocked. Applied unconditionally, not left to the caller, because the
 * caller's text is LLM-authored and this is a platform-level safety floor.
 */
const SAFE_ALLOWED_MENTIONS = { parse: [AllowedMentionsTypes.User] };

function requireBotToken(creds: ChannelCredentials): string {
  const botToken = creds['botToken'];
  if (!botToken) {
    throw new DeliveryError('discord_no_token', 'discord_no_token: missing botToken credential');
  }
  return botToken;
}

function requireChannelId(conversationId: string): string {
  if (!conversationId) {
    throw new DeliveryError(
      'discord_no_channel_id',
      'discord_no_channel_id: missing conversationId',
    );
  }
  return conversationId;
}

/**
 * discord.js's REST client, versioned to API v10. Cheap to construct (no
 * network call happens here) — the rate-limit bucket bookkeeping it does is
 * per-call-site anyway, so nothing is lost by not caching this across calls.
 */
function makeRestClient(botToken: string): REST {
  return new REST({ version: '10' }).setToken(botToken);
}

/**
 * Map a discord.js REST failure onto a DeliveryError. Discord's own auth/rate
 * codes don't get a bespoke DeliveryErrorCode each the way Telegram's do (yet) —
 * 'send_failed' is the generic bucket new adapters use until real callers need
 * to distinguish a failure mode (see errors.ts). The bot token is redacted from
 * the message defensively, even though discord.js never places it in a URL —
 * same defense-in-depth as Telegram's H-1 redaction.
 */
function toDeliveryError(err: unknown, botToken: string): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const redact = (msg: string): string => msg.replaceAll(botToken, '[REDACTED]');
  if (err instanceof DiscordAPIError) {
    return new DeliveryError(
      'send_failed',
      redact(`send_failed: Discord API error ${err.status} (code ${err.code}): ${err.message}`),
    );
  }
  if (err instanceof HTTPError) {
    return new DeliveryError(
      'send_failed',
      redact(`send_failed: Discord HTTP error ${err.status}: ${err.message}`),
    );
  }
  if (err instanceof RateLimitError) {
    // Only reachable if a future caller opts into rejectOnRateLimit — by
    // default the REST client queues and waits out 429s itself (documented
    // below on sendText), so this branch exists for completeness, not because
    // today's calls can hit it.
    return new DeliveryError(
      'send_failed',
      redact(`send_failed: Discord rate limit: ${err.message}`),
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new DeliveryError('send_failed', redact(`send_failed: ${msg}`));
}

/** Discord's hard per-message content limit. */
const DISCORD_MAX_CHARS = 2000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Hard-split a string into chunks of at most `max` UTF-16 code units without
 * cutting a surrogate pair. Duplicated from channels/telegram.ts's `hardSplit`
 * on purpose (per-channel files don't import each other's internals) — same
 * proven logic, Discord's own limit swapped in.
 */
function hardSplit(line: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    let end = Math.min(i + max, line.length);
    if (
      end < line.length &&
      end - 1 > i &&
      isHighSurrogate(line.charCodeAt(end - 1)) &&
      isLowSurrogate(line.charCodeAt(end))
    ) {
      end -= 1;
    }
    out.push(line.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Split text into Discord-sized chunks (≤ DISCORD_MAX_CHARS), preferring
 * paragraph/line boundaries so a message is never cut mid-line. Mirrors
 * channels/telegram.ts's `chunkForTelegram` exactly, at Discord's own limit.
 * Always returns at least one chunk (an empty string included).
 */
function chunkForDiscord(text: string, max = DISCORD_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...hardSplit(line, max));
      continue;
    }
    const sepLen = current ? 1 : 0;
    if (current.length + sepLen + line.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Channel-neutral format hint → Discord support. Discord renders markdown
 *  natively, so 'plain'/'markdown' are both a passthrough of the raw text;
 *  'html' has no Discord equivalent and must fail loud rather than send text
 *  full of literal, unrendered tags. */
function assertFormatSupported(format: TextFormat | undefined): void {
  switch (format) {
    case 'markdown':
    case 'plain':
    case undefined:
      return;
    case 'html':
      throw new DeliveryError(
        'send_failed',
        'send_failed: Discord adapter does not support format "html" — Discord renders markdown natively; use format "markdown" (or omit format) instead.',
      );
    default: {
      // Exhaustiveness guard — a new TextFormat member must be handled above.
      const _exhaustive: never = format;
      throw new DeliveryError('send_failed', `send_failed: unknown text format "${_exhaustive}"`);
    }
  }
}

/**
 * Send text to a Discord channel. Text over DISCORD_MAX_CHARS is split into
 * multiple messages on line boundaries (chunkForDiscord) — same rationale as
 * Telegram: without it, Discord rejects an over-long message outright.
 *
 * 429s are NOT retried here: discord.js's REST client queues requests per
 * rate-limit bucket and waits out `retry_after` internally by default
 * (rejectOnRateLimit is unset), so a 429 never surfaces to this call unless
 * discord.js itself gives up — house rule: don't hand-roll what the SDK
 * already does.
 */
async function sendText(
  creds: ChannelCredentials,
  conversationId: string,
  text: string,
  opts?: { format?: TextFormat },
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  assertFormatSupported(opts?.format);
  const rest = makeRestClient(botToken);

  let last: APIMessage | undefined;
  for (const chunk of chunkForDiscord(text)) {
    const body: RESTPostAPIChannelMessageJSONBody = {
      content: chunk,
      allowed_mentions: SAFE_ALLOWED_MENTIONS,
    };
    try {
      last = (await rest.post(Routes.channelMessages(channelId), { body })) as APIMessage;
    } catch (err) {
      throw toDeliveryError(err, botToken);
    }
  }
  if (!last) {
    // Unreachable — chunkForDiscord always returns at least one chunk.
    throw new DeliveryError('send_failed', 'send_failed: no chunks produced for a non-empty send');
  }
  return { messageId: last.id };
}

/**
 * Upload a file to a Discord channel (multipart, files[0]). Discord doesn't
 * distinguish photo/document/video/audio/voice the way Telegram does — every
 * OutboundMedia.kind maps onto the same single-attachment upload; `kind` is
 * intentionally unused below.
 */
async function sendMedia(
  creds: ChannelCredentials,
  conversationId: string,
  media: OutboundMedia,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  const rest = makeRestClient(botToken);

  const { bytes, filename, caption } = media;
  const body: RESTPostAPIChannelMessageJSONBody = { allowed_mentions: SAFE_ALLOWED_MENTIONS };
  if (caption !== undefined) body.content = caption;
  const files: RawFile[] = [{ name: filename, data: Buffer.from(bytes) }];

  let message: APIMessage;
  try {
    message = (await rest.post(Routes.channelMessages(channelId), { body, files })) as APIMessage;
  } catch (err) {
    throw toDeliveryError(err, botToken);
  }
  return { messageId: message.id };
}

/**
 * ApprovalCard → a Discord action row with two buttons. `custom_id` carries
 * the SAME `${callbackId}:a` / `${callbackId}:r` suffix convention as
 * Telegram's `callback_data` (see telegram-adapter.ts) — the neutral approval
 * callback parser relies on that exact suffix regardless of channel.
 */
async function sendApprovalCard(
  creds: ChannelCredentials,
  conversationId: string,
  card: ApprovalCard,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  const rest = makeRestClient(botToken);

  const approveButton: APIButtonComponentWithCustomId = {
    type: ComponentType.Button,
    style: ButtonStyle.Success,
    label: card.approveLabel,
    custom_id: `${card.callbackId}:a`,
  };
  const rejectButton: APIButtonComponentWithCustomId = {
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    label: card.rejectLabel,
    custom_id: `${card.callbackId}:r`,
  };
  const actionRow: APIActionRowComponent<APIComponentInMessageActionRow> = {
    type: ComponentType.ActionRow,
    components: [approveButton, rejectButton],
  };
  const body: RESTPostAPIChannelMessageJSONBody = {
    content: card.text,
    components: [actionRow],
    allowed_mentions: SAFE_ALLOWED_MENTIONS,
  };

  let message: APIMessage;
  try {
    message = (await rest.post(Routes.channelMessages(channelId), { body })) as APIMessage;
  } catch (err) {
    throw toDeliveryError(err, botToken);
  }
  return { messageId: message.id };
}

/**
 * Edit a previously-sent message's text. Best-effort like Telegram's
 * editTelegramMessageText: this is used to turn a resolved approval card into
 * its resolved state, and a failed edit must not undo a decision that already
 * happened — so, deliberately, this never throws.
 */
async function editMessageText(
  creds: ChannelCredentials,
  conversationId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  const rest = makeRestClient(botToken);
  const body: RESTPatchAPIChannelMessageJSONBody = {
    content: text,
    allowed_mentions: SAFE_ALLOWED_MENTIONS,
  };
  try {
    await rest.patch(Routes.channelMessage(channelId, messageId), { body });
  } catch {
    /* best-effort — the resolution already happened */
  }
}

/** Bound on how many guilds `listConversations` will walk. A bot installed
 *  into hundreds of servers must not turn one discovery call into hundreds of
 *  sequential `/guilds/{id}/channels` round-trips — anything beyond the cap
 *  is logged and dropped rather than silently truncated without a trace. */
const MAX_GUILDS = 25;

/** Text-capable channel types this discovery surfaces. Voice/stage/category
 *  channels have no message history an agent could send into, so they're
 *  filtered out rather than exposed as a dead-end conversation target. */
const TEXT_CAPABLE_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);

/**
 * Enumerate the text-capable channels of every guild this bot is in.
 * Discord has no single "all channels this bot can see" endpoint — it's
 * GET /users/@me/guilds, then GET /guilds/{id}/channels per guild — so this
 * is inherently N+1 requests, bounded by MAX_GUILDS.
 */
async function listConversations(creds: ChannelCredentials): Promise<DiscoveredConversation[]> {
  const botToken = requireBotToken(creds);
  const rest = makeRestClient(botToken);

  let guilds: RESTGetAPICurrentUserGuildsResult;
  try {
    guilds = (await rest.get(Routes.userGuilds())) as RESTGetAPICurrentUserGuildsResult;
  } catch (err) {
    throw toDeliveryError(err, botToken);
  }
  if (guilds.length > MAX_GUILDS) {
    console.warn(
      `[discord-adapter] listConversations: bot is in ${guilds.length} guilds, truncating to ${MAX_GUILDS}`,
    );
    guilds = guilds.slice(0, MAX_GUILDS);
  }

  const conversations: DiscoveredConversation[] = [];
  for (const guild of guilds) {
    let channels: RESTGetAPIGuildChannelsResult;
    try {
      channels = (await rest.get(Routes.guildChannels(guild.id))) as RESTGetAPIGuildChannelsResult;
    } catch (err) {
      throw toDeliveryError(err, botToken);
    }
    for (const channel of channels as APIGuildChannel<GuildChannelType>[]) {
      if (!TEXT_CAPABLE_CHANNEL_TYPES.has(channel.type)) continue;
      conversations.push({
        conversationId: channel.id,
        name: `#${channel.name}`,
        kind: 'channel',
        groupName: guild.name,
      });
    }
  }
  return conversations;
}

/** Validate a bot token via GET /users/@me. Throws `discord_invalid_token` on
 *  a 401 — any other failure gets the generic `send_failed` mapping. */
async function validateCredentials(creds: ChannelCredentials): Promise<BotIdentity> {
  const botToken = requireBotToken(creds);
  const rest = makeRestClient(botToken);

  let user: APIUser;
  try {
    user = (await rest.get(Routes.user())) as APIUser;
  } catch (err) {
    if (err instanceof DiscordAPIError && err.status === 401) {
      throw new DeliveryError('discord_invalid_token', `discord_invalid_token: ${err.message}`);
    }
    throw toDeliveryError(err, botToken);
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.global_name ?? user.username,
  };
}

export const discordAdapter: ChannelAdapter = {
  channel: 'discord',
  capabilities: { buttons: true, threads: true, media: true, editMessage: true },
  sendText,
  sendMedia,
  sendApprovalCard,
  editMessageText,
  listConversations,
  validateCredentials,
};
