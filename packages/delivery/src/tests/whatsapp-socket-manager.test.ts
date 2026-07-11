// whatsapp-socket-manager.test.ts — the Baileys-backed singleton: per-key
// reuse, reconnect-except-loggedOut, qr re-emission, and inbound message
// mapping (DM vs group, fromMe/status-broadcast/protocol ignored).
//
// Baileys is mocked at the module boundary (vi.mock) — makeWASocket returns
// a fake socket whose `.ev` is a real Node EventEmitter, so tests drive
// connection.update / messages.upsert exactly like the real event flow
// without any real websocket/auth-state I/O.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ensureWhatsAppSocket,
  closeWhatsAppSocket,
  type WhatsAppInboundMessage,
} from '../channels/whatsapp/socket-manager.ts';

const { mockMakeWASocket, mockUseMultiFileAuthState } = vi.hoisted(() => ({
  mockMakeWASocket: vi.fn(),
  mockUseMultiFileAuthState: vi.fn(),
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: mockMakeWASocket,
  useMultiFileAuthState: mockUseMultiFileAuthState,
  DisconnectReason: { loggedOut: 401 },
  // Real implementation (not a mock) — jid comparison is pure string logic,
  // no reason to fake it, and mentionsSelf tests below depend on it working.
  areJidsSameUser: (jid1: string | undefined, jid2: string | undefined) =>
    jid1?.split('@')[0]?.split(':')[0] === jid2?.split('@')[0]?.split(':')[0],
}));

interface FakeSocket {
  ev: EventEmitter;
  user: { id: string; name?: string; notify?: string; verifiedName?: string } | undefined;
  sendMessage: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeFakeSocket(): FakeSocket {
  return {
    ev: new EventEmitter(),
    user: undefined,
    sendMessage: vi.fn(),
    end: vi.fn(),
  };
}

let sockets: FakeSocket[] = [];
let keyCounter = 0;
/** A fresh bindingKey per test — the registry is module-level singleton
 *  state, so reusing a key across tests would leak a live socket forward. */
function nextKey(): string {
  keyCounter += 1;
  return `binding-${keyCounter}`;
}

beforeEach(() => {
  sockets = [];
  mockMakeWASocket.mockReset().mockImplementation(() => {
    const sock = makeFakeSocket();
    sockets.push(sock);
    return sock;
  });
  mockUseMultiFileAuthState.mockReset().mockResolvedValue({
    state: {},
    saveCreds: vi.fn(),
  });
});

async function waitForFirstSocket(): Promise<FakeSocket> {
  await vi.waitFor(() => expect(mockMakeWASocket).toHaveBeenCalled());
  return sockets[0]!;
}

function baseKey(
  remoteJid: string,
  opts?: { fromMe?: boolean; participant?: string; id?: string },
) {
  return {
    remoteJid,
    fromMe: opts?.fromMe ?? false,
    participant: opts?.participant,
    id: opts?.id ?? 'msg-1',
  };
}

describe('ensureWhatsAppSocket', () => {
  it('returns the same handle for the same bindingKey without creating a second socket', async () => {
    const key = nextKey();
    const handle1 = ensureWhatsAppSocket(key, { sessionDir: '/sessions/a' });
    await waitForFirstSocket();
    const handle2 = ensureWhatsAppSocket(key, { sessionDir: '/sessions/a' });

    expect(handle2).toBe(handle1);
    expect(mockMakeWASocket).toHaveBeenCalledTimes(1);
  });

  it('starts in "connecting" status before the socket connects', () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/b' });
    expect(handle.getStatus()).toBe('connecting');
    expect(handle.getIdentity()).toBeNull();
  });

  it('emits qr and sets status qr_pending on a qr code, re-emitting on refresh', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/c' });
    const sock = await waitForFirstSocket();
    const qrCodes: string[] = [];
    handle.events.on('qr', (qr) => qrCodes.push(qr));

    sock.ev.emit('connection.update', { qr: 'QR_ONE' });
    expect(handle.getStatus()).toBe('qr_pending');
    sock.ev.emit('connection.update', { qr: 'QR_TWO' });

    expect(qrCodes).toEqual(['QR_ONE', 'QR_TWO']);
  });

  it('moves to "open" and captures the linked identity from sock.user', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/d' });
    const sock = await waitForFirstSocket();
    sock.user = { id: '1234@s.whatsapp.net', name: 'My Phone' };

    sock.ev.emit('connection.update', { connection: 'open' });

    expect(handle.getStatus()).toBe('open');
    expect(handle.getIdentity()).toEqual({
      id: '1234@s.whatsapp.net',
      username: null,
      displayName: 'My Phone',
    });
  });

  it('reconnects (creates a new socket) on close for a reason other than loggedOut', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/e' });
    const sock = await waitForFirstSocket();

    sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
    });

    expect(handle.getStatus()).toBe('closed');
    await vi.waitFor(() => expect(mockMakeWASocket).toHaveBeenCalledTimes(2));
  });

  it('does NOT reconnect and sets status logged_out on a loggedOut close', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/f' });
    const sock = await waitForFirstSocket();

    sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } }, date: new Date() },
    });

    expect(handle.getStatus()).toBe('logged_out');
    // Give any (incorrect) reconnect attempt a chance to fire, then assert it didn't.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockMakeWASocket).toHaveBeenCalledTimes(1);
  });
});

describe('ensureWhatsAppSocket — inbound message mapping', () => {
  async function emitAndCapture(payload: unknown): Promise<WhatsAppInboundMessage[]> {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/msg' });
    const sock = await waitForFirstSocket();
    const received: WhatsAppInboundMessage[] = [];
    handle.events.on('message', (msg) => received.push(msg));
    sock.ev.emit('messages.upsert', payload);
    return received;
  }

  it('maps a DM text message: isGroup false, senderJid equals the DM jid', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [
        {
          key: baseKey('111@s.whatsapp.net'),
          message: { conversation: 'hello there' },
          pushName: 'Alice',
          messageTimestamp: 1700000000,
        },
      ],
    });

    expect(received).toEqual([
      {
        conversationId: '111@s.whatsapp.net',
        senderJid: '111@s.whatsapp.net',
        senderName: 'Alice',
        text: 'hello there',
        timestamp: 1700000000,
        isGroup: false,
        mentionsSelf: false,
      },
    ]);
  });

  it('maps a group message: isGroup true, senderJid is the participant, not the group jid', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [
        {
          key: baseKey('999-group@g.us', { participant: '222@s.whatsapp.net' }),
          message: { extendedTextMessage: { text: 'hi group' } },
          pushName: 'Bob',
          messageTimestamp: 1700000001,
        },
      ],
    });

    expect(received).toEqual([
      {
        conversationId: '999-group@g.us',
        senderJid: '222@s.whatsapp.net',
        senderName: 'Bob',
        text: 'hi group',
        timestamp: 1700000001,
        isGroup: true,
        mentionsSelf: false,
      },
    ]);
  });

  it('sets mentionsSelf true when contextInfo.mentionedJid includes the linked account', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/mention' });
    const sock = await waitForFirstSocket();
    sock.user = { id: '999@s.whatsapp.net' };
    const received: WhatsAppInboundMessage[] = [];
    handle.events.on('message', (msg) => received.push(msg));

    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: baseKey('999-group@g.us', { participant: '222@s.whatsapp.net' }),
          message: {
            extendedTextMessage: {
              text: '@bot hi there',
              contextInfo: { mentionedJid: ['999@s.whatsapp.net'] },
            },
          },
          pushName: 'Bob',
          messageTimestamp: 1700000002,
        },
      ],
    });

    expect(received[0]?.mentionsSelf).toBe(true);
  });

  it('sets mentionsSelf false when contextInfo.mentionedJid excludes the linked account', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/no-mention' });
    const sock = await waitForFirstSocket();
    sock.user = { id: '999@s.whatsapp.net' };
    const received: WhatsAppInboundMessage[] = [];
    handle.events.on('message', (msg) => received.push(msg));

    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: baseKey('999-group@g.us', { participant: '222@s.whatsapp.net' }),
          message: {
            extendedTextMessage: {
              text: '@someoneelse hi there',
              contextInfo: { mentionedJid: ['555@s.whatsapp.net'] },
            },
          },
          pushName: 'Bob',
          messageTimestamp: 1700000003,
        },
      ],
    });

    expect(received[0]?.mentionsSelf).toBe(false);
  });

  it('ignores messages where key.fromMe is true', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [
        {
          key: baseKey('111@s.whatsapp.net', { fromMe: true }),
          message: { conversation: 'echo' },
          messageTimestamp: 1,
        },
      ],
    });
    expect(received).toEqual([]);
  });

  it('ignores status@broadcast messages', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [
        {
          key: baseKey('status@broadcast'),
          message: { conversation: 'someone posted a status' },
          messageTimestamp: 1,
        },
      ],
    });
    expect(received).toEqual([]);
  });

  it('ignores protocol/receipt messages that carry no `message` payload', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [{ key: baseKey('111@s.whatsapp.net'), messageTimestamp: 1 }],
    });
    expect(received).toEqual([]);
  });

  it('ignores "append" batches (history/offline backfill) — only "notify" is live', async () => {
    const received = await emitAndCapture({
      type: 'append',
      messages: [
        {
          key: baseKey('111@s.whatsapp.net'),
          message: { conversation: 'old' },
          messageTimestamp: 1,
        },
      ],
    });
    expect(received).toEqual([]);
  });

  it('surfaces a media message as a placeholder with its caption, not the raw bytes', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [
        {
          key: baseKey('111@s.whatsapp.net'),
          message: { imageMessage: { caption: 'look at this' } },
          messageTimestamp: 1,
        },
      ],
    });
    expect(received).toEqual([
      {
        conversationId: '111@s.whatsapp.net',
        senderJid: '111@s.whatsapp.net',
        senderName: null,
        text: 'look at this',
        timestamp: 1,
        isGroup: false,
        mentionsSelf: false,
        mediaPlaceholder: true,
      },
    ]);
  });

  it('surfaces a captionless media message with an empty text and mediaPlaceholder', async () => {
    const received = await emitAndCapture({
      type: 'notify',
      messages: [
        {
          key: baseKey('111@s.whatsapp.net'),
          message: { audioMessage: {} },
          messageTimestamp: 1,
        },
      ],
    });
    expect(received[0]?.text).toBe('');
    expect(received[0]?.mediaPlaceholder).toBe(true);
  });
});

describe('closeWhatsAppSocket', () => {
  it('ends the live socket and forgets the binding — a later ensureWhatsAppSocket creates a fresh one', async () => {
    const key = nextKey();
    ensureWhatsAppSocket(key, { sessionDir: '/sessions/g' });
    const sock = await waitForFirstSocket();

    closeWhatsAppSocket(key);
    expect(sock.end).toHaveBeenCalledWith(undefined);

    ensureWhatsAppSocket(key, { sessionDir: '/sessions/g' });
    await vi.waitFor(() => expect(mockMakeWASocket).toHaveBeenCalledTimes(2));
  });

  it('is a no-op for an unregistered bindingKey', () => {
    expect(() => closeWhatsAppSocket('never-registered')).not.toThrow();
  });
});
