// channels/whatsapp-adapter.ts — ChannelAdapter implementation over the
// socket-manager singleton (whatsapp/socket-manager.ts). Unlike Discord/
// Telegram, WhatsApp has no REST API to call per-send: every method below
// resolves the live Baileys socket for this binding and dispatches into it.
//
// `creds.sessionDir` IS the credential (see whatsapp/socket-manager.ts's
// header): a `useMultiFileAuthState` folder holding the linked device's keys,
// not a token/secret string like Telegram/Discord. This adapter uses the
// session dir itself as the socket-manager's `bindingKey`, so inbound
// (runner ingress, a later brique, calling `ensureWhatsAppSocket` with the
// SAME credentials row) and outbound (this file) always resolve the exact
// same live socket without any extra id plumbing.
//
// capabilities.buttons is false: WhatsApp (via Baileys) has no equivalent of
// Telegram's inline keyboard / Discord's message components in this phase,
// so `sendApprovalCard` is intentionally NOT implemented here.

import type { AnyMessageContent, GroupMetadata } from '@whiskeysockets/baileys';
import { DeliveryError } from '../errors.ts';
import {
  ensureWhatsAppSocket,
  type WhatsAppHandle,
  type WhatsAppStatus,
} from './whatsapp/socket-manager.ts';
import type {
  ChannelAdapter,
  ChannelCredentials,
  DiscoveredConversation,
  OutboundMedia,
  SendResult,
  BotIdentity,
  TextFormat,
} from '../channel-adapter.ts';

/** How long validateCredentials waits for a fresh/reconnecting socket to
 *  reach 'open' before giving up. Pairing itself (scanning the QR) is a
 *  separate, user-driven flow owned by a later UI brique — this is just the
 *  bounded wait for an ALREADY-linked session's socket to come back up. */
const WHATSAPP_PAIR_TIMEOUT_MS = 15_000;

/** WhatsApp's own per-message text limit is far higher than this, but the
 *  product spec for this brique fixes chunking at 4096 (Telegram's limit) —
 *  consistent chunk sizing across channels rather than maxing out each one. */
const WHATSAPP_MAX_CHARS = 4096;

function requireSessionDir(creds: ChannelCredentials): string {
  const sessionDir = creds['sessionDir'];
  if (!sessionDir) {
    throw new DeliveryError(
      'whatsapp_send_failed',
      'whatsapp_send_failed: missing sessionDir credential',
    );
  }
  return sessionDir;
}

function requireJid(conversationId: string): string {
  if (!conversationId) {
    throw new DeliveryError('whatsapp_send_failed', 'whatsapp_send_failed: missing conversationId');
  }
  return conversationId;
}

function toDeliveryError(err: unknown): DeliveryError {
  if (err instanceof DeliveryError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new DeliveryError('whatsapp_send_failed', `whatsapp_send_failed: ${msg}`);
}

/** Channel-neutral format hint → WhatsApp support. 'html' has no WhatsApp
 *  equivalent and must fail loud rather than send literal, unrendered tags. */
function assertFormatSupported(format: TextFormat | undefined): void {
  switch (format) {
    case 'markdown':
    case 'plain':
    case undefined:
      return;
    case 'html':
      throw new DeliveryError(
        'whatsapp_send_failed',
        'whatsapp_send_failed: WhatsApp adapter does not support format "html" — use format "markdown" (or omit format) instead.',
      );
    default: {
      // Exhaustiveness guard — a new TextFormat member must be handled above.
      const _exhaustive: never = format;
      throw new DeliveryError(
        'whatsapp_send_failed',
        `whatsapp_send_failed: unknown text format "${_exhaustive}"`,
      );
    }
  }
}

/**
 * Minimal markdown → WhatsApp formatting conversion: `**bold**` → `*bold*`
 * (WhatsApp's own bold marker). Pure fn, deliberately narrow — WhatsApp's
 * `_italic_` already matches common markdown so needs no conversion, and
 * strikethrough (`~~x~~` vs WhatsApp's `~x~`) is left for whenever a real
 * caller needs it (channel-adapter.ts's own extension rule).
 */
function markdownToWhatsApp(text: string): string {
  // `[\s\S]` instead of a dotAll `.` — same "match across newlines" behavior
  // without requiring the `s` flag (which needs an es2018+ compile target;
  // apps/docs's tsconfig, which also compiles this package, targets lower).
  return text.replace(/\*\*([\s\S]+?)\*\*/g, '*$1*');
}

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
 * proven logic, WhatsApp's own chunk cap swapped in.
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
 * Split text into WhatsApp-sized chunks (≤ WHATSAPP_MAX_CHARS), preferring
 * paragraph/line boundaries. Mirrors discord-adapter.ts's `chunkForDiscord`
 * exactly, at this channel's own limit. Always returns at least one chunk
 * (an empty string included).
 */
function chunkForWhatsApp(text: string, max = WHATSAPP_MAX_CHARS): string[] {
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

/** Tiny local extension → mimetype map for the handful of kinds this product
 *  actually sends as WhatsApp documents. Baileys requires `mimetype` on a
 *  document upload (unlike image/video, which it can sniff); a full mime
 *  database is unwarranted for that single field, so this stays a narrow
 *  fallback list, not a general-purpose mime resolver. */
function guessDocumentMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const known: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return known[ext] ?? 'application/octet-stream';
}

/**
 * OutboundMedia → Baileys' AnyMessageContent. WhatsApp's audio/voice message
 * types carry no caption field at all (unlike image/video/document) — a
 * caption on those OutboundMedia kinds is silently dropped, mirroring the
 * real WhatsApp client's own limitation rather than working around it.
 */
function toWhatsAppContent(media: OutboundMedia): AnyMessageContent {
  const buffer = Buffer.from(media.bytes);
  switch (media.kind) {
    case 'photo':
      return { image: buffer, caption: media.caption };
    case 'video':
      return { video: buffer, caption: media.caption };
    case 'document':
      return {
        document: buffer,
        fileName: media.filename,
        caption: media.caption,
        mimetype: guessDocumentMimeType(media.filename),
      };
    case 'audio':
      return { audio: buffer, mimetype: 'audio/mp4' };
    case 'voice':
      return { audio: buffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' };
    default: {
      // Exhaustiveness guard — a new OutboundMedia.kind must be handled above.
      const _exhaustive: never = media.kind;
      throw new DeliveryError(
        'whatsapp_send_failed',
        `whatsapp_send_failed: unknown media kind "${_exhaustive}"`,
      );
    }
  }
}

async function sendText(
  creds: ChannelCredentials,
  conversationId: string,
  text: string,
  opts?: { format?: TextFormat },
): Promise<SendResult> {
  const sessionDir = requireSessionDir(creds);
  const jid = requireJid(conversationId);
  assertFormatSupported(opts?.format);
  const body = opts?.format === 'markdown' ? markdownToWhatsApp(text) : text;
  const handle = ensureWhatsAppSocket(sessionDir, { sessionDir });

  let messageId = '';
  try {
    for (const chunk of chunkForWhatsApp(body)) {
      messageId = await handle.send(jid, { text: chunk });
    }
  } catch (err) {
    throw toDeliveryError(err);
  }
  return { messageId };
}

async function sendMedia(
  creds: ChannelCredentials,
  conversationId: string,
  media: OutboundMedia,
): Promise<SendResult> {
  const sessionDir = requireSessionDir(creds);
  const jid = requireJid(conversationId);
  const handle = ensureWhatsAppSocket(sessionDir, { sessionDir });

  let messageId: string;
  try {
    messageId = await handle.send(jid, toWhatsAppContent(media));
  } catch (err) {
    throw toDeliveryError(err);
  }
  return { messageId };
}

/** Wait for `handle` to reach 'open' (returning its identity) or fail —
 *  'logged_out' or the timeout — resolving to null either way. */
function waitForIdentity(handle: WhatsAppHandle, timeoutMs: number): Promise<BotIdentity | null> {
  if (handle.getStatus() === 'open') return Promise.resolve(handle.getIdentity());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      handle.events.off('status', onStatus);
      resolve(null);
    }, timeoutMs);
    function onStatus(status: WhatsAppStatus): void {
      if (status === 'open') {
        clearTimeout(timer);
        handle.events.off('status', onStatus);
        resolve(handle.getIdentity());
      } else if (status === 'logged_out') {
        clearTimeout(timer);
        handle.events.off('status', onStatus);
        resolve(null);
      }
    }
    handle.events.on('status', onStatus);
  });
}

/**
 * Enumerate the groups the linked account currently participates in.
 * DMs are NOT enumerable here — unlike Discord's guild list or Slack's
 * users.conversations, WhatsApp/Baileys exposes no contact-list API a bot
 * could use to discover its 1:1 chats, only the groups it's a participant
 * of (groupFetchAllParticipating). Throws `whatsapp_not_paired` — same code
 * validateCredentials uses for "not a usable, linked session" — rather than
 * a generic send failure, since an unlinked socket isn't a transient error.
 */
async function listConversations(creds: ChannelCredentials): Promise<DiscoveredConversation[]> {
  // Not requireSessionDir (that throws the generic whatsapp_send_failed) —
  // this is a discovery/read op tied to pairing state like validateCredentials,
  // so a missing credential gets the same whatsapp_not_paired code as an
  // unlinked socket, not a transport failure code.
  const sessionDir = creds['sessionDir'];
  if (!sessionDir) {
    throw new DeliveryError(
      'whatsapp_not_paired',
      'whatsapp_not_paired: missing sessionDir credential',
    );
  }
  const handle = ensureWhatsAppSocket(sessionDir, { sessionDir });
  if (handle.getStatus() !== 'open') {
    throw new DeliveryError(
      'whatsapp_not_paired',
      `whatsapp_not_paired: socket is not "open" (status=${handle.getStatus()}) — link this WhatsApp account first`,
    );
  }

  let groups: GroupMetadata[];
  try {
    groups = await handle.listGroups();
  } catch (err) {
    throw toDeliveryError(err);
  }
  return groups.map((group) => ({
    conversationId: group.id,
    name: group.subject,
    kind: 'group' as const,
  }));
}

/**
 * Returns the linked account's identity once the socket for this session
 * reaches 'open'; throws `whatsapp_not_paired` if it doesn't within
 * WHATSAPP_PAIR_TIMEOUT_MS (or logs out while waiting), or if the sessionDir
 * credential is missing outright — either way, this session isn't a usable,
 * paired WhatsApp link.
 */
async function validateCredentials(creds: ChannelCredentials): Promise<BotIdentity> {
  const sessionDir = creds['sessionDir'];
  if (!sessionDir) {
    throw new DeliveryError(
      'whatsapp_not_paired',
      'whatsapp_not_paired: missing sessionDir credential',
    );
  }
  const handle = ensureWhatsAppSocket(sessionDir, { sessionDir });
  const identity = await waitForIdentity(handle, WHATSAPP_PAIR_TIMEOUT_MS);
  if (!identity) {
    throw new DeliveryError(
      'whatsapp_not_paired',
      `whatsapp_not_paired: socket did not reach "open" with existing credentials within ${WHATSAPP_PAIR_TIMEOUT_MS}ms — link this WhatsApp account first`,
    );
  }
  return identity;
}

export const whatsappAdapter: ChannelAdapter = {
  channel: 'whatsapp',
  capabilities: { buttons: false, threads: false, media: true, editMessage: false },
  sendText,
  sendMedia,
  listConversations,
  validateCredentials,
};
