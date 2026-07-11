// channels/whatsapp/socket-manager.ts — the per-binding Baileys socket
// singleton. WHY this exists here and not split like Discord's runner-side
// gateway.ts: WhatsApp has NO REST API — outbound sends go through the SAME
// live websocket that receives inbound messages. Both directions therefore
// need the identical `WASocket` instance, so it's owned in this shared
// package rather than in the runner (which only ever sees the outbound side
// via whatsapp-adapter.ts). The runner's inbound ingress (a later brique)
// subscribes to `handle.events` — dependency points delivery → nothing,
// runner → delivery, never the other way.
//
// SECURITY: `opts.sessionDir` (via useMultiFileAuthState) holds this
// binding's WhatsApp DEVICE KEYS on disk — treat it like a credential store.
// Nothing in this file logs its contents, and QR payloads are only ever
// carried through the typed `qr` event, never printed or logged here.
//
// Singleton key: `bindingKey` is caller-supplied — whatsapp-adapter.ts uses
// the session dir itself (see its header comment for why that's sufficient
// to let inbound and outbound resolve the SAME socket without extra
// plumbing). This module doesn't care what the key means, only that one key
// maps to at most one live socket.
//
// Baileys version pin (package.json): EXACT "6.7.23", not a caret range.
// `npm dist-tag ls @whiskeysockets/baileys` shows `legacy: 6.7.23` /
// `latest: 7.0.0-rc13` (the 7.x line is still a release candidate, with a
// native Rust bridge dependency — too much unproven surface for a shipped
// feature). A caret range on 6.7.23 is UNSAFE here specifically: semver
// order doesn't track chronological order on this package — 6.17.16 (higher
// semver, resolved by `^6.7.23`) predates 6.7.23 by over a year and carries
// a published security advisory (message-spoofing zero-day, GHSA-qvv5-jq5g-4cgg).
// The maintainers patched the "legacy" line by publishing 6.7.23 AFTER
// 6.17.16 without bumping past it. Exact-pinning avoids resolving backwards
// into the vulnerable release.

import { EventEmitter } from 'node:events';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  areJidsSameUser,
  type WASocket,
  type WAMessage,
  type AnyMessageContent,
  type ConnectionState,
  type GroupMetadata,
} from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { pino } from 'pino';
import type { BotIdentity } from '../../channel-adapter.ts';

export type WhatsAppStatus = 'connecting' | 'qr_pending' | 'open' | 'logged_out' | 'closed';

/** Neutral inbound message shape — TEXT ONLY this phase. A media message
 *  (image/video/document/audio/sticker) still surfaces here so the agent
 *  isn't silently blind to it, with `text` set to its caption (or '') and
 *  `mediaPlaceholder: true`; actual media bytes are NOT downloaded (media
 *  intake is deferred to a later brique). */
export interface WhatsAppInboundMessage {
  /** The chat this message arrived in — a user JID (`…@s.whatsapp.net`) or group JID (`…@g.us`). */
  conversationId: string;
  /** The actual sender's JID — equals `conversationId` in a DM, the participant JID in a group. */
  senderJid: string;
  senderName: string | null;
  text: string;
  timestamp: number;
  isGroup: boolean;
  mediaPlaceholder?: true;
  /**
   * True when this message's `contextInfo.mentionedJid` (Baileys' own @mention
   * carrier) includes the linked account's own JID. Unlike Discord/Slack,
   * Baileys gives no upstream mention gate for group messages — the runner's
   * inbound handler needs this to build its OWN gate — so it's always
   * computed, never left undefined: false in a DM (not meaningful there),
   * false before the socket has linked an identity to compare against.
   */
  mentionsSelf: boolean;
}

interface WhatsAppEvents {
  qr: [qr: string];
  status: [status: WhatsAppStatus];
  message: [message: WhatsAppInboundMessage];
}

/** Minimal typed wrapper over Node's EventEmitter for this module's 3
 *  events (qr/status/message) — keeps every call site free of `any`-typed
 *  listener args without a new dependency. */
export class WhatsAppEventEmitter extends EventEmitter {
  override on<K extends keyof WhatsAppEvents>(
    event: K,
    listener: (...args: WhatsAppEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override once<K extends keyof WhatsAppEvents>(
    event: K,
    listener: (...args: WhatsAppEvents[K]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof WhatsAppEvents>(
    event: K,
    listener: (...args: WhatsAppEvents[K]) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof WhatsAppEvents>(event: K, ...args: WhatsAppEvents[K]): boolean {
    return super.emit(event, ...args);
  }
}

export interface WhatsAppSocketOpts {
  /** Directory holding this binding's `useMultiFileAuthState` data. Caller's
   *  responsibility to choose/scope — this module stays path-policy-free. */
  sessionDir: string;
}

export interface WhatsAppHandle {
  readonly bindingKey: string;
  readonly events: WhatsAppEventEmitter;
  getStatus(): WhatsAppStatus;
  /** Identity of the linked account once the socket has reached 'open'; null before then. */
  getIdentity(): BotIdentity | null;
  /** Send raw Baileys message content through the live socket. Throws a plain
   *  Error (mapped to a DeliveryError by the adapter) when the socket isn't 'open'. */
  send(jid: string, content: AnyMessageContent): Promise<string>;
  /** Every group the linked account currently participates in. Throws a plain
   *  Error (mapped to a DeliveryError by the adapter) when the socket isn't
   *  'open' — same guard as `send`. */
  listGroups(): Promise<GroupMetadata[]>;
}

interface RegistryEntry {
  handle: WhatsAppHandle;
  close(): void;
}

const registry = new Map<string, RegistryEntry>();

const STATUS_BROADCAST_JID = 'status@broadcast';

/** Extract renderable content from a proto message, or null for anything
 *  this phase doesn't surface (protocol messages, reactions, receipts, …).
 *  TEXT ONLY: a media message is flagged via `mediaPlaceholder` rather than
 *  downloaded — media intake is deferred to a later brique. */
function extractContent(message: proto.IMessage): { text: string; mediaPlaceholder?: true } | null {
  if (message.conversation) return { text: message.conversation };
  if (message.extendedTextMessage?.text) return { text: message.extendedTextMessage.text };
  const media =
    message.imageMessage ??
    message.videoMessage ??
    message.documentMessage ??
    message.audioMessage ??
    message.stickerMessage;
  if (media) {
    const caption = 'caption' in media ? (media.caption ?? '') : '';
    return { text: caption, mediaPlaceholder: true };
  }
  return null;
}

/** `contextInfo` (carrying `mentionedJid`) lives on whichever message variant
 *  this actually is — a plain `conversation` string never carries one (a
 *  literal @mention in WhatsApp is always sent as `extendedTextMessage`), so
 *  only the variants extractContent above already reads are checked here. */
function extractMentionedJids(message: proto.IMessage): string[] {
  const contextInfo =
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
    undefined;
  return contextInfo?.mentionedJid ?? [];
}

function mapInboundMessage(
  msg: WAMessage,
  ownJid: string | undefined,
): WhatsAppInboundMessage | null {
  if (msg.key.fromMe) return null;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === STATUS_BROADCAST_JID) return null;
  if (!msg.message) return null; // protocol/status/receipt — no renderable content
  const content = extractContent(msg.message);
  if (!content) return null;

  const isGroup = remoteJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant ?? remoteJid) : remoteJid;
  const timestampRaw = msg.messageTimestamp;
  const timestamp = typeof timestampRaw === 'number' ? timestampRaw : Number(timestampRaw ?? 0);
  const mentionedJids = extractMentionedJids(msg.message);
  const mentionsSelf =
    ownJid !== undefined && mentionedJids.some((jid) => areJidsSameUser(jid, ownJid));

  return {
    conversationId: remoteJid,
    senderJid,
    senderName: msg.pushName ?? null,
    text: content.text,
    timestamp,
    isGroup,
    mentionsSelf,
    ...(content.mediaPlaceholder ? { mediaPlaceholder: true as const } : {}),
  };
}

function toIdentity(user: WASocket['user']): BotIdentity | null {
  if (!user) return null;
  return {
    id: user.id,
    username: null,
    displayName: user.name ?? user.notify ?? user.verifiedName ?? null,
  };
}

/**
 * Resolve (creating on first call) the singleton Baileys socket for
 * `bindingKey`. Synchronous by design — mirrors runner's
 * `startDiscordGateway`: the handle (and its `events` emitter) is available
 * immediately with `status: 'connecting'`; the actual auth-state load +
 * websocket connect happen asynchronously and are reported via the `status`/
 * `qr` events. A second call with the SAME `bindingKey` returns the existing
 * handle untouched (its `opts` are ignored — a binding's session dir doesn't
 * change without going through `closeWhatsAppSocket` first).
 */
export function ensureWhatsAppSocket(bindingKey: string, opts: WhatsAppSocketOpts): WhatsAppHandle {
  const existing = registry.get(bindingKey);
  if (existing) return existing.handle;

  const events = new WhatsAppEventEmitter();
  const state: {
    status: WhatsAppStatus;
    identity: BotIdentity | null;
    sock: WASocket | undefined;
  } = {
    status: 'connecting',
    identity: null,
    sock: undefined,
  };
  let closed = false;

  function setStatus(next: WhatsAppStatus): void {
    state.status = next;
    events.emit('status', next);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const { state: authState, saveCreds } = await useMultiFileAuthState(opts.sessionDir);
    if (closed) return; // closed while the auth state was loading

    const sock = makeWASocket({
      auth: authState,
      logger: pino({ level: 'silent' }),
    });
    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        setStatus('qr_pending');
        events.emit('qr', qr);
      }
      if (connection === 'open') {
        state.identity = toIdentity(sock.user);
        setStatus('open');
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        setStatus(loggedOut ? 'logged_out' : 'closed');
        if (!loggedOut && !closed) void connect(); // auto-reconnect, reusing the same on-disk auth state
      }
    });

    sock.ev.on(
      'messages.upsert',
      (upsert: { messages: WAMessage[]; type: 'append' | 'notify' }) => {
        // Only 'notify' is a live, just-arrived message — 'append' covers
        // history/offline-backfill batches, which this phase doesn't surface.
        if (upsert.type !== 'notify') return;
        for (const msg of upsert.messages) {
          const mapped = mapInboundMessage(msg, sock.user?.id);
          if (mapped) events.emit('message', mapped);
        }
      },
    );
  }

  void connect();

  const handle: WhatsAppHandle = {
    bindingKey,
    events,
    getStatus: () => state.status,
    getIdentity: () => state.identity,
    async send(jid, content) {
      if (state.status !== 'open' || !state.sock) {
        throw new Error(`whatsapp socket "${bindingKey}" is not open (status=${state.status})`);
      }
      const result = await state.sock.sendMessage(jid, content);
      return result?.key.id ?? '';
    },
    async listGroups() {
      if (state.status !== 'open' || !state.sock) {
        throw new Error(`whatsapp socket "${bindingKey}" is not open (status=${state.status})`);
      }
      const participating = await state.sock.groupFetchAllParticipating();
      return Object.values(participating);
    },
  };

  registry.set(bindingKey, {
    handle,
    close: () => {
      closed = true;
      state.sock?.end(undefined);
    },
  });
  return handle;
}

/** Stop and forget the socket for `bindingKey` (e.g. binding disabled/removed).
 *  A no-op if none is registered. Does NOT log the account out — `sock.end()`
 *  closes the live connection without invalidating the session, so a later
 *  `ensureWhatsAppSocket` for the same session dir reconnects without re-pairing. */
export function closeWhatsAppSocket(bindingKey: string): void {
  const entry = registry.get(bindingKey);
  if (!entry) return;
  entry.close();
  registry.delete(bindingKey);
}
