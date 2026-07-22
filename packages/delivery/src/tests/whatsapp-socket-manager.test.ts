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

  it('reconnects (creates a new socket) on close for a reason other than loggedOut, after a backoff delay', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/e' });
    const sock = await waitForFirstSocket();

    vi.useFakeTimers();
    try {
      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
      });
      expect(handle.getStatus()).toBe('closed');

      // Not an immediate hot-loop reconnect — must wait out the backoff.
      await vi.advanceTimersByTimeAsync(999);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('doubles the reconnect backoff on consecutive closes, capped, and resets it once "open" is reached', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/backoff' });
    const sock1 = await waitForFirstSocket();

    vi.useFakeTimers();
    try {
      // 1st close → 1000ms backoff.
      sock1.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(2);

      // 2nd consecutive close → backoff doubles to 2000ms, not 1000ms again.
      const sock2 = sockets[1]!;
      sock2.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(3);

      // Reaching 'open' resets the counter — the NEXT close backs off at
      // 1000ms again, not 4000ms.
      const sock3 = sockets[2]!;
      sock3.ev.emit('connection.update', { connection: 'open' });
      expect(handle.getStatus()).toBe('open');

      sock3.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the pending reconnect timer on close() — no reconnect fires after the handle is closed', async () => {
    const key = nextKey();
    ensureWhatsAppSocket(key, { sessionDir: '/sessions/cancel-backoff' });
    const sock = await waitForFirstSocket();

    vi.useFakeTimers();
    try {
      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
      });
      closeWhatsAppSocket(key);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockMakeWASocket).toHaveBeenCalledTimes(1); // still just the original socket
    } finally {
      vi.useRealTimers();
    }
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

  it('sets status "closed" without an unhandled rejection when the initial connect() fails (e.g. a corrupted sessionDir)', async () => {
    mockUseMultiFileAuthState.mockReset().mockRejectedValueOnce(new Error('sessionDir corrupted'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/corrupt' });

    await vi.waitFor(() => expect(handle.getStatus()).toBe('closed'));
    expect(consoleErrorSpy).toHaveBeenCalledWith('[whatsapp] connect failed', expect.any(Error));
    expect(mockMakeWASocket).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('sets status "closed" without an unhandled rejection when a BACKED-OFF auto-reconnect attempt itself fails', async () => {
    const handle = ensureWhatsAppSocket(nextKey(), { sessionDir: '/sessions/reconnect-fails' });
    const sock = await waitForFirstSocket();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      mockUseMultiFileAuthState.mockRejectedValueOnce(new Error('sessionDir corrupted mid-flight'));
      sock.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(handle.getStatus()).toBe('closed');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[whatsapp] connect failed', expect.any(Error));
      expect(mockMakeWASocket).toHaveBeenCalledTimes(1); // the failed reconnect never got to makeWASocket
    } finally {
      vi.useRealTimers();
      consoleErrorSpy.mockRestore();
    }
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
