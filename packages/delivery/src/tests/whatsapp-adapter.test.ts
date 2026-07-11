// whatsapp-adapter.test.ts — WhatsApp ChannelAdapter: chunking, markdown→*bold*
// conversion, media payload shapes, html rejection, validateCredentials'
// pairing wait. The socket-manager is mocked at the module boundary (a fake
// WhatsAppHandle) — this adapter's own logic (not Baileys') is under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { whatsappAdapter } from '../channels/whatsapp-adapter.ts';
import { DeliveryError } from '../errors.ts';
import type { BotIdentity } from '../channel-adapter.ts';
import type { WhatsAppStatus } from '../channels/whatsapp/socket-manager.ts';

const { mockEnsureWhatsAppSocket } = vi.hoisted(() => ({
  mockEnsureWhatsAppSocket: vi.fn(),
}));

vi.mock('../channels/whatsapp/socket-manager.ts', () => ({
  ensureWhatsAppSocket: mockEnsureWhatsAppSocket,
}));

const CREDS = { sessionDir: '/sessions/test' };
const JID = '111@s.whatsapp.net';

interface FakeHandle {
  bindingKey: string;
  events: EventEmitter;
  getStatus(): WhatsAppStatus;
  getIdentity(): BotIdentity | null;
  send: ReturnType<typeof vi.fn>;
  listGroups: ReturnType<typeof vi.fn>;
}

function makeFakeHandle(
  initialStatus: WhatsAppStatus,
  identity: BotIdentity | null = null,
): FakeHandle {
  const events = new EventEmitter();
  const status = initialStatus;
  const send = vi.fn().mockResolvedValue('wamsg-1');
  const listGroups = vi.fn().mockResolvedValue([]);
  return {
    bindingKey: CREDS.sessionDir,
    events,
    getStatus: () => status,
    getIdentity: () => identity,
    send,
    listGroups,
    // test-only helper to drive status transitions
    // (not part of WhatsAppHandle — attached for convenience below)
  } as FakeHandle & { setStatus: (s: WhatsAppStatus) => void };
}

function setStatus(handle: FakeHandle, status: WhatsAppStatus): void {
  (handle as unknown as { getStatus(): WhatsAppStatus }).getStatus = () => status;
  handle.events.emit('status', status);
}

beforeEach(() => {
  mockEnsureWhatsAppSocket.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('whatsappAdapter.channel / capabilities', () => {
  it('identifies as whatsapp, no buttons/threads/editMessage, has sendMedia', () => {
    expect(whatsappAdapter.channel).toBe('whatsapp');
    expect(whatsappAdapter.capabilities).toEqual({
      buttons: false,
      threads: false,
      media: true,
      editMessage: false,
    });
    expect(whatsappAdapter.sendApprovalCard).toBeUndefined();
    expect(whatsappAdapter.editMessageText).toBeUndefined();
  });
});

describe('whatsappAdapter.sendText', () => {
  it('sends plain text through the live socket and returns its message id', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const result = await whatsappAdapter.sendText(CREDS, JID, 'Hello');

    expect(mockEnsureWhatsAppSocket).toHaveBeenCalledWith('/sessions/test', {
      sessionDir: '/sessions/test',
    });
    expect(handle.send).toHaveBeenCalledWith(JID, { text: 'Hello' });
    expect(result).toEqual({ messageId: 'wamsg-1' });
  });

  it('is a no-op passthrough for format "plain"', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendText(CREDS, JID, '**bold**', { format: 'plain' });

    expect(handle.send).toHaveBeenCalledWith(JID, { text: '**bold**' });
  });

  it('converts **bold** to WhatsApp\'s *bold* for format "markdown"', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendText(CREDS, JID, 'This is **very** important', {
      format: 'markdown',
    });

    expect(handle.send).toHaveBeenCalledWith(JID, { text: 'This is *very* important' });
  });

  it('throws whatsapp_send_failed for format "html" without touching the socket', async () => {
    await expect(
      whatsappAdapter.sendText(CREDS, JID, '<b>x</b>', { format: 'html' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_send_failed',
    );
    expect(mockEnsureWhatsAppSocket).not.toHaveBeenCalled();
  });

  it("splits text over 4096 chars into multiple sends, returning the LAST chunk's message id", async () => {
    const handle = makeFakeHandle('open');
    let sent = 0;
    handle.send.mockImplementation(() => Promise.resolve(`chunk-${(sent += 1)}`));
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const longText = Array.from({ length: 100 }, (_, i) => `line ${i} `.repeat(20)).join('\n');
    expect(longText.length).toBeGreaterThan(4096);

    const result = await whatsappAdapter.sendText(CREDS, JID, longText);

    expect(handle.send.mock.calls.length).toBeGreaterThan(1);
    for (const [, content] of handle.send.mock.calls) {
      expect((content as { text: string }).text.length).toBeLessThanOrEqual(4096);
    }
    expect(result).toEqual({ messageId: `chunk-${sent}` });
  });

  it('throws whatsapp_send_failed when sessionDir credential is missing', async () => {
    await expect(whatsappAdapter.sendText({}, JID, 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_send_failed',
    );
    expect(mockEnsureWhatsAppSocket).not.toHaveBeenCalled();
  });

  it('throws whatsapp_send_failed when conversationId is empty', async () => {
    await expect(whatsappAdapter.sendText(CREDS, '', 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_send_failed',
    );
    expect(mockEnsureWhatsAppSocket).not.toHaveBeenCalled();
  });

  it('maps a handle.send() rejection (e.g. socket not open) to whatsapp_send_failed', async () => {
    const handle = makeFakeHandle('connecting');
    handle.send.mockRejectedValueOnce(
      new Error('whatsapp socket "x" is not open (status=connecting)'),
    );
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await expect(whatsappAdapter.sendText(CREDS, JID, 'Hello')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DeliveryError &&
        err.code === 'whatsapp_send_failed' &&
        err.message.includes('not open'),
    );
  });
});

describe('whatsappAdapter.sendMedia', () => {
  const BYTES = new Uint8Array([1, 2, 3, 4]);

  it('sends a photo as { image, caption }', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const result = await whatsappAdapter.sendMedia(CREDS, JID, {
      kind: 'photo',
      bytes: BYTES,
      filename: 'a.png',
      caption: 'a caption',
    });

    expect(handle.send).toHaveBeenCalledWith(JID, {
      image: Buffer.from(BYTES),
      caption: 'a caption',
    });
    expect(result).toEqual({ messageId: 'wamsg-1' });
  });

  it('sends a video as { video, caption }', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendMedia(CREDS, JID, { kind: 'video', bytes: BYTES, filename: 'a.mp4' });

    expect(handle.send).toHaveBeenCalledWith(JID, {
      video: Buffer.from(BYTES),
      caption: undefined,
    });
  });

  it('sends a document with fileName, caption, and a guessed mimetype', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendMedia(CREDS, JID, {
      kind: 'document',
      bytes: BYTES,
      filename: 'report.pdf',
      caption: 'the report',
    });

    expect(handle.send).toHaveBeenCalledWith(JID, {
      document: Buffer.from(BYTES),
      fileName: 'report.pdf',
      caption: 'the report',
      mimetype: 'application/pdf',
    });
  });

  it('falls back to application/octet-stream for an unrecognized document extension', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendMedia(CREDS, JID, {
      kind: 'document',
      bytes: BYTES,
      filename: 'data.xyz',
    });

    const content = handle.send.mock.calls[0]?.[1] as { mimetype: string };
    expect(content.mimetype).toBe('application/octet-stream');
  });

  it('sends audio as { audio, mimetype } — WhatsApp audio has no caption field', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendMedia(CREDS, JID, {
      kind: 'audio',
      bytes: BYTES,
      filename: 'a.m4a',
      caption: 'ignored',
    });

    expect(handle.send).toHaveBeenCalledWith(JID, {
      audio: Buffer.from(BYTES),
      mimetype: 'audio/mp4',
    });
  });

  it('sends voice as { audio, ptt: true, mimetype } — no caption field either', async () => {
    const handle = makeFakeHandle('open');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await whatsappAdapter.sendMedia(CREDS, JID, { kind: 'voice', bytes: BYTES, filename: 'v.ogg' });

    expect(handle.send).toHaveBeenCalledWith(JID, {
      audio: Buffer.from(BYTES),
      ptt: true,
      mimetype: 'audio/ogg; codecs=opus',
    });
  });
});

describe('whatsappAdapter.listConversations', () => {
  it('maps participating groups into DiscoveredConversation[] when the socket is open', async () => {
    const handle = makeFakeHandle('open');
    handle.listGroups.mockResolvedValue([
      { id: '1-group@g.us', subject: 'Family', owner: undefined, participants: [] },
      { id: '2-group@g.us', subject: 'Work', owner: undefined, participants: [] },
    ]);
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const result = await whatsappAdapter.listConversations!(CREDS);

    expect(result).toEqual([
      { conversationId: '1-group@g.us', name: 'Family', kind: 'group' },
      { conversationId: '2-group@g.us', name: 'Work', kind: 'group' },
    ]);
  });

  it('throws whatsapp_not_paired without calling listGroups when the socket is not open', async () => {
    const handle = makeFakeHandle('connecting');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await expect(whatsappAdapter.listConversations!(CREDS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_not_paired',
    );
    expect(handle.listGroups).not.toHaveBeenCalled();
  });

  it('throws whatsapp_not_paired when sessionDir credential is missing', async () => {
    await expect(whatsappAdapter.listConversations!({})).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_not_paired',
    );
    expect(mockEnsureWhatsAppSocket).not.toHaveBeenCalled();
  });
});

describe('whatsappAdapter.validateCredentials', () => {
  it('throws whatsapp_not_paired when sessionDir credential is missing', async () => {
    await expect(whatsappAdapter.validateCredentials({})).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_not_paired',
    );
    expect(mockEnsureWhatsAppSocket).not.toHaveBeenCalled();
  });

  it('resolves immediately when the socket is already open', async () => {
    const identity: BotIdentity = { id: '1@s.whatsapp.net', username: null, displayName: 'Phone' };
    const handle = makeFakeHandle('open', identity);
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    await expect(whatsappAdapter.validateCredentials(CREDS)).resolves.toEqual(identity);
  });

  it('resolves once the socket transitions to open while waiting', async () => {
    const identity: BotIdentity = { id: '1@s.whatsapp.net', username: null, displayName: 'Phone' };
    const handle = makeFakeHandle('connecting', identity);
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const promise = whatsappAdapter.validateCredentials(CREDS);
    setStatus(handle, 'open');

    await expect(promise).resolves.toEqual(identity);
  });

  it('throws whatsapp_not_paired if the socket logs out while waiting', async () => {
    const handle = makeFakeHandle('connecting');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const promise = whatsappAdapter.validateCredentials(CREDS);
    setStatus(handle, 'logged_out');

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_not_paired',
    );
  });

  it('throws whatsapp_not_paired if the socket never reaches open before the pairing timeout', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle('connecting');
    mockEnsureWhatsAppSocket.mockReturnValue(handle);

    const promise = whatsappAdapter.validateCredentials(CREDS);
    const assertion = expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'whatsapp_not_paired',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
