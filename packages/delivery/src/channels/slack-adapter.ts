// channels/slack-adapter.ts — ChannelAdapter implementation for Slack
// (OUTBOUND only — the Socket Mode ingress lives in apps/runner via @slack/bolt).
//
// `@slack/web-api`'s WebClient is the official low-level HTTP layer (house rule
// on official SDKs) — like discord.js's REST client, it queues requests and
// retries 429s internally by default (rejectRateLimitedCalls is unset), so
// there is no separate hand-rolled retry/backoff here, mirroring the Discord
// adapter's approach.
//
// A fresh WebClient is built per call from the caller-supplied bot token
// (makeClient) rather than cached — same rationale as Discord's
// makeRestClient: different jobs can carry different entities' bot tokens.

import { WebClient, ErrorCode } from '@slack/web-api';
import type { CodedError, WebAPIPlatformError } from '@slack/web-api';
import type { SectionBlock, ActionsBlock, Button } from '@slack/types';
import { DeliveryError } from '../errors.ts';
import type {
  ChannelAdapter,
  ChannelCredentials,
  OutboundMedia,
  ApprovalCard,
  SendResult,
  BotIdentity,
  TextFormat,
} from '../channel-adapter.ts';

function requireBotToken(creds: ChannelCredentials): string {
  const botToken = creds['botToken'];
  if (!botToken) {
    throw new DeliveryError('slack_no_token', 'slack_no_token: missing botToken credential');
  }
  return botToken;
}

function requireChannelId(conversationId: string): string {
  if (!conversationId) {
    throw new DeliveryError('slack_no_channel_id', 'slack_no_channel_id: missing conversationId');
  }
  return conversationId;
}

/**
 * `@slack/web-api`'s WebClient, built fresh per call — cheap to construct (no
 * network call happens here), same as Discord's makeRestClient.
 */
function makeClient(botToken: string): WebClient {
  return new WebClient(botToken);
}

function isPlatformError(err: unknown): err is WebAPIPlatformError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Partial<CodedError>).code === ErrorCode.PlatformError
  );
}

/**
 * Map a WebClient failure onto a DeliveryError. Slack's own platform error
 * codes (`data.error`, e.g. "channel_not_found", "missing_scope") don't get a
 * bespoke DeliveryErrorCode each — 'send_failed' is the generic bucket new
 * adapters use until a real caller needs to distinguish a failure mode (see
 * errors.ts), mirroring what toDeliveryError does in discord-adapter.ts. The
 * bot token is redacted from the message defensively, same defense-in-depth
 * as Discord's and Telegram's redaction.
 */
function toDeliveryError(err: unknown, botToken: string): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const redact = (msg: string): string => msg.replaceAll(botToken, '[REDACTED]');
  if (isPlatformError(err)) {
    return new DeliveryError(
      'send_failed',
      redact(`send_failed: Slack API error: ${err.data.error}`),
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new DeliveryError('send_failed', redact(`send_failed: ${msg}`));
}

/** Slack's documented soft cap on `chat.postMessage` text (~40k chars) is far
 *  above what a chat message is actually legible at; 3900 mirrors Discord's
 *  own margin-under-the-hard-cap approach so a chunk always leaves headroom
 *  for Slack's own truncation/formatting overhead. */
const SLACK_MAX_CHARS = 3900;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Hard-split a string into chunks of at most `max` UTF-16 code units without
 * cutting a surrogate pair. Duplicated from discord-adapter.ts's `hardSplit`
 * on purpose (per-channel files don't import each other's internals) — same
 * proven logic, Slack's own limit swapped in.
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
 * Split text into Slack-sized chunks (≤ SLACK_MAX_CHARS), preferring
 * paragraph/line boundaries so a message is never cut mid-line. Mirrors
 * discord-adapter.ts's `chunkForDiscord` exactly, at Slack's own limit.
 * Always returns at least one chunk (an empty string included).
 */
function chunkForSlack(text: string, max = SLACK_MAX_CHARS): string[] {
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

/**
 * Minimal, pure markdown → Slack mrkdwn conversion. Slack's mrkdwn already
 * uses `_italics_` (single underscore) exactly like common markdown, so
 * italics need no rewrite — only the two divergences are handled:
 *  - `**bold**` (markdown) → `*bold*` (mrkdwn's own bold marker)
 *  - `[text](url)` (markdown link) → `<url|text>` (mrkdwn's own link syntax)
 */
function mdToMrkdwn(text: string): string {
  const withBold = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  return withBold.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
}

/** Channel-neutral format hint → Slack's mrkdwn. 'html' has no mrkdwn
 *  equivalent and must fail loud rather than send text full of literal,
 *  unrendered tags — same rationale as Discord's assertFormatSupported. */
function toSlackText(text: string, format: TextFormat | undefined): string {
  switch (format) {
    case 'markdown':
      return mdToMrkdwn(text);
    case 'plain':
    case undefined:
      return text;
    case 'html':
      throw new DeliveryError(
        'send_failed',
        'send_failed: Slack adapter does not support format "html" — Slack renders mrkdwn, not HTML; use format "markdown" (or omit format) instead.',
      );
    default: {
      // Exhaustiveness guard — a new TextFormat member must be handled above.
      const _exhaustive: never = format;
      throw new DeliveryError('send_failed', `send_failed: unknown text format "${_exhaustive}"`);
    }
  }
}

/**
 * Send text to a Slack channel. Text over SLACK_MAX_CHARS is split into
 * multiple messages on line boundaries (chunkForSlack) — same rationale as
 * Discord/Telegram: without it, Slack rejects an over-long message outright.
 *
 * 429s are NOT retried here: WebClient queues and waits out `Retry-After`
 * internally by default (rejectRateLimitedCalls is unset) — house rule:
 * don't hand-roll what the SDK already does.
 */
async function sendText(
  creds: ChannelCredentials,
  conversationId: string,
  text: string,
  opts?: { format?: TextFormat },
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  const rendered = toSlackText(text, opts?.format);
  const client = makeClient(botToken);

  let lastTs: string | undefined;
  for (const chunk of chunkForSlack(rendered)) {
    try {
      const result = await client.chat.postMessage({ channel: channelId, text: chunk });
      lastTs = result.ts;
    } catch (err) {
      throw toDeliveryError(err, botToken);
    }
  }
  if (!lastTs) {
    throw new DeliveryError(
      'send_failed',
      'send_failed: chat.postMessage returned no ts to identify the sent message',
    );
  }
  return { messageId: lastTs };
}

/** Shape of the parts of `files.uploadV2`'s response this adapter reads. The
 *  SDK types the call as a generic `WebAPICallResult` (see file-upload.ts's
 *  runtime implementation, which wraps `files.completeUploadExternal`) —
 *  this local, minimal type documents exactly what's actually read back. */
interface SlackUploadV2Result {
  files?: Array<{ files?: Array<{ id?: string }> }>;
}

/**
 * Upload a file to a Slack channel via `files.uploadV2` (the SDK-recommended
 * replacement for the deprecated `files.upload`). Slack doesn't distinguish
 * photo/document/video/audio/voice the way Telegram does — every
 * OutboundMedia.kind maps onto the same single-file upload; `kind` is
 * intentionally unused below, mirroring the Discord adapter.
 */
async function sendMedia(
  creds: ChannelCredentials,
  conversationId: string,
  media: OutboundMedia,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  const client = makeClient(botToken);

  const { bytes, filename, caption } = media;
  const uploadArgs: Parameters<typeof client.files.uploadV2>[0] = {
    channel_id: channelId,
    file: Buffer.from(bytes),
    filename,
  };
  if (caption !== undefined) uploadArgs.initial_comment = caption;

  let result: SlackUploadV2Result;
  try {
    result = (await client.files.uploadV2(uploadArgs)) as SlackUploadV2Result;
  } catch (err) {
    throw toDeliveryError(err, botToken);
  }
  const fileId = result.files?.[0]?.files?.[0]?.id;
  if (!fileId) {
    throw new DeliveryError('send_failed', 'send_failed: files.uploadV2 returned no file id');
  }
  return { messageId: fileId };
}

/**
 * ApprovalCard → a Slack section block (card.text as mrkdwn) + an actions
 * block with two buttons. `action_id` carries the SAME `${callbackId}:a` /
 * `${callbackId}:r` suffix convention as Telegram's `callback_data` and
 * Discord's `custom_id` (see telegram-adapter.ts / discord-adapter.ts) — the
 * neutral approval-callback parser relies on that exact suffix regardless of
 * channel; Slack's `block_actions` interaction payload carries `action_id`
 * the same way. `text` is also set at the top level as Slack's own
 * notification-fallback text (screen readers/push previews), same pattern
 * `chat.postMessage` uses whenever `blocks` is present.
 */
async function sendApprovalCard(
  creds: ChannelCredentials,
  conversationId: string,
  card: ApprovalCard,
): Promise<SendResult> {
  const botToken = requireBotToken(creds);
  const channelId = requireChannelId(conversationId);
  const client = makeClient(botToken);

  const sectionBlock: SectionBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: card.text },
  };
  const approveButton: Button = {
    type: 'button',
    style: 'primary',
    text: { type: 'plain_text', text: card.approveLabel },
    action_id: `${card.callbackId}:a`,
  };
  const rejectButton: Button = {
    type: 'button',
    style: 'danger',
    text: { type: 'plain_text', text: card.rejectLabel },
    action_id: `${card.callbackId}:r`,
  };
  const actionsBlock: ActionsBlock = { type: 'actions', elements: [approveButton, rejectButton] };

  let ts: string | undefined;
  try {
    const result = await client.chat.postMessage({
      channel: channelId,
      text: card.text,
      blocks: [sectionBlock, actionsBlock],
    });
    ts = result.ts;
  } catch (err) {
    throw toDeliveryError(err, botToken);
  }
  if (!ts) {
    throw new DeliveryError(
      'send_failed',
      'send_failed: chat.postMessage returned no ts to identify the sent card',
    );
  }
  return { messageId: ts };
}

/**
 * Edit a previously-sent message's text. Best-effort like Telegram's and
 * Discord's edit: this is used to turn a resolved approval card into its
 * resolved state, and a failed edit must not undo a decision that already
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
  const client = makeClient(botToken);
  try {
    await client.chat.update({ channel: channelId, ts: messageId, text });
  } catch {
    /* best-effort — the resolution already happened */
  }
}

/**
 * Validate a bot's credentials via `auth.test`, plus the app-level token that
 * rides alongside it. The Slack ChannelCredentials bag carries BOTH tokens —
 * `botToken` (used by every method above, via `chat.*`/`files.*`) and
 * `appToken` (unused by this outbound adapter; it's what apps/runner's
 * Socket Mode ingress needs to open its websocket) — because the two are
 * issued together for one Slack app and stored as a single credential unit;
 * validating only `botToken` here would let a broken/missing `appToken` slip
 * through undetected until the ingress side tries to connect.
 */
async function validateCredentials(creds: ChannelCredentials): Promise<BotIdentity> {
  const botToken = requireBotToken(creds);
  const appToken = creds['appToken'];
  if (!appToken || !appToken.startsWith('xapp-')) {
    throw new DeliveryError(
      'slack_invalid_token',
      'slack_invalid_token: missing or malformed appToken credential (expected an app-level token starting with "xapp-", used by the Socket Mode ingress)',
    );
  }

  const client = makeClient(botToken);
  try {
    const result = await client.auth.test();
    return {
      id: result.bot_id ?? result.user_id ?? '',
      username: result.user ?? null,
      displayName: result.user ?? null,
    };
  } catch (err) {
    if (isPlatformError(err)) {
      throw new DeliveryError('slack_invalid_token', `slack_invalid_token: ${err.data.error}`);
    }
    throw toDeliveryError(err, botToken);
  }
}

export const slackAdapter: ChannelAdapter = {
  channel: 'slack',
  capabilities: { buttons: true, threads: true, media: true, editMessage: true },
  sendText,
  sendMedia,
  sendApprovalCard,
  editMessageText,
  validateCredentials,
};
