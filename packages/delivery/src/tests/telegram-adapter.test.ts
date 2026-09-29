// telegram-adapter.test.ts — ChannelAdapter delegates to the existing
// channels/telegram.ts functions with zero behavior change: same fetch URL,
// same wire body, same error codes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { telegramAdapter } from '../channels/telegram-adapter.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_TOKEN = 'bot123:ABCDEF';
const FAKE_CHAT_ID = '987654321';
const CREDS = { botToken: FAKE_TOKEN };

function makeFetchResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('telegramAdapter.channel / capabilities', () => {
  it('identifies as telegram with the expected capability flags', () => {
    expect(telegramAdapter.channel).toBe('telegram');
    expect(telegramAdapter.capabilities).toEqual({
      buttons: true,
      threads: false,
      media: true,
      editMessage: true,
    });
  });
});

describe('telegramAdapter.sendText', () => {
  it('posts to sendMessage with chat_id/text, same as sendTelegramMessage', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 42 } }),
    );

    const result = await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, 'Hello');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['chat_id']).toBe(FAKE_CHAT_ID);
    expect(body['text']).toBe('Hello');
    expect('parse_mode' in body).toBe(false);
    expect(result).toEqual({ messageId: '42' });
  });

  it('maps format "markdown" to Telegram parse_mode MarkdownV2', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );

    await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, 'Hello', { format: 'markdown' });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['parse_mode']).toBe('MarkdownV2');
  });

  it('maps format "html" to Telegram parse_mode HTML', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );

    await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, 'Hello', { format: 'html' });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['parse_mode']).toBe('HTML');
  });

  it('throws telegram_no_token when botToken credential is missing', async () => {
    await expect(telegramAdapter.sendText({}, FAKE_CHAT_ID, 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'telegram_no_token',
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws telegram_no_chat_id when conversationId is empty', async () => {
    await expect(telegramAdapter.sendText(CREDS, '', 'Hello')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'telegram_no_chat_id',
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('propagates telegram_unauthorized on 401, unchanged', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, 'x')).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'telegram_unauthorized',
    );
  });
});

describe('telegramAdapter.sendMedia', () => {
  const BYTES = new Uint8Array([1, 2, 3, 4]);

  it('routes "photo" to sendPhoto with the right form fields', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 7 } }),
    );

    const result = await telegramAdapter.sendMedia(CREDS, FAKE_CHAT_ID, {
      kind: 'photo',
      bytes: BYTES,
      filename: 'a.png',
      caption: 'a caption',
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendPhoto`);
    const fd = init!.body as FormData;
    expect(fd.get('chat_id')).toBe(FAKE_CHAT_ID);
    expect(fd.get('caption')).toBe('a caption');
    expect(fd.get('photo')).toBeInstanceOf(Blob);
    expect(result).toEqual({ messageId: '7' });
  });

  it.each([
    ['document', 'sendDocument', 'document'],
    ['video', 'sendVideo', 'video'],
    ['audio', 'sendAudio', 'audio'],
    ['voice', 'sendVoice', 'voice'],
  ] as const)('routes "%s" to %s with form field "%s"', async (kind, method, field) => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 9 } }),
    );

    const result = await telegramAdapter.sendMedia(CREDS, FAKE_CHAT_ID, {
      kind,
      bytes: BYTES,
      filename: 'f.bin',
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/${method}`);
    const fd = init!.body as FormData;
    expect(fd.get(field)).toBeInstanceOf(Blob);
    expect(result).toEqual({ messageId: '9' });
  });
});

describe('telegramAdapter.sendApprovalCard', () => {
  it('produces the EXACT inline-keyboard wire shape approval-callback.ts expects', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 5 } }),
    );

    const result = await telegramAdapter.sendApprovalCard!(CREDS, FAKE_CHAT_ID, {
      text: 'Approve this?',
      approveLabel: '✅ Approve',
      rejectLabel: '❌ Reject',
      callbackId: 'apr:req-123',
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['text']).toBe('Approve this?');
    expect(body['reply_markup']).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: 'apr:req-123:a' },
          { text: '❌ Reject', callback_data: 'apr:req-123:r' },
        ],
      ],
    });
    expect(result).toEqual({ messageId: '5' });
  });

  it('« Toujours autoriser » : troisième bouton sur sa PROPRE ligne, suffixe :w', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 6 } }),
    );

    await telegramAdapter.sendApprovalCard!(CREDS, FAKE_CHAT_ID, {
      text: 'Approve this?',
      approveLabel: '✅ Approve',
      rejectLabel: '❌ Reject',
      alwaysLabel: '🔁 Always allow',
      callbackId: 'apr:req-456',
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['reply_markup']).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: 'apr:req-456:a' },
          { text: '❌ Reject', callback_data: 'apr:req-456:r' },
        ],
        [{ text: '🔁 Always allow', callback_data: 'apr:req-456:w' }],
      ],
    });
  });
});

describe('telegramAdapter.editMessageText', () => {
  it('calls editMessageText with a numeric message_id and the new text', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeFetchResponse(200, { ok: true }));

    await telegramAdapter.editMessageText!(CREDS, FAKE_CHAT_ID, '42', 'Resolved ✅');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/editMessageText`);
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['message_id']).toBe(42);
    expect(body['text']).toBe('Resolved ✅');
    expect(body['reply_markup']).toEqual({ inline_keyboard: [] });
  });
});

describe('telegramAdapter.validateCredentials', () => {
  it('maps getMe onto BotIdentity', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, {
        ok: true,
        result: {
          id: 555,
          is_bot: true,
          first_name: 'My Bot',
          username: 'my_bot',
        },
      }),
    );

    const identity = await telegramAdapter.validateCredentials(CREDS);

    expect(identity).toEqual({ id: '555', username: 'my_bot', displayName: 'My Bot' });
  });

  it('throws telegram_no_token when botToken credential is missing', async () => {
    await expect(telegramAdapter.validateCredentials({})).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'telegram_no_token',
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('throws telegram_invalid_token on 401, unchanged', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(telegramAdapter.validateCredentials(CREDS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DeliveryError && err.code === 'telegram_invalid_token',
    );
  });
});

// #613 — the runner splits, the model never does. The prompt tells the agent
// "a long text is split automatically" on the strength of this adapter's
// declaration; this proves the declaration is what sendText does.
describe('telegramAdapter.text — what a sent text becomes (#613)', () => {
  it('declares that no mark renders: sendText sets no parse_mode, so markup arrives as typed', async () => {
    expect(telegramAdapter.text.renders).toEqual([]);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, '**bold** _x_');
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ chat_id: FAKE_CHAT_ID, text: '**bold** _x_' });
  });

  it('a 9 000-character text passed to sendText goes out as 3 messages, in order, whole', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 7 } })),
    );
    // 90 lines of 99 characters + newline, minus the last newline: 8 999.
    const text = Array.from(
      { length: 90 },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(97)}`,
    ).join('\n');
    expect(text.length).toBeGreaterThanOrEqual(8999);

    await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, text);

    const sent = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([, init]) => (JSON.parse(init?.body as string) as { text: string }).text);
    expect(sent).toHaveLength(3);
    for (const part of sent)
      expect(part.length).toBeLessThanOrEqual(telegramAdapter.text.maxMessageChars);
    expect(sent.join('\n')).toBe(text);
  });
});

// #613, review of #615 — without a length cap, one reply is several messages.
// A failure on the 3rd of 4 used to leave 1 and 2 delivered with nothing to
// say so: the retry resent all four. The error says how far it got, and a
// send resumed from there delivers only the rest.
describe('telegramAdapter.sendText — a send that fails partway resumes, never repeats (#615)', () => {
  it('fails on part 3 of 4 with its progress; resumed, only parts 3 and 4 go out', async () => {
    const max = telegramAdapter.text.maxMessageChars;
    const text = 'y'.repeat(3 * max + 100);
    let call = 0;
    vi.mocked(globalThis.fetch).mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 3
          ? makeFetchResponse(400, { ok: false, error_code: 400, description: 'Bad Request' })
          : makeFetchResponse(200, { ok: true, result: { message_id: call } }),
      );
    });

    const err = await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, text).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as DeliveryError).partialProgress).toEqual({ sentChunks: 2, totalChunks: 4 });

    await telegramAdapter.sendText(CREDS, FAKE_CHAT_ID, text, { fromChunk: 2 });

    const bodies = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([, init]) => (JSON.parse(init?.body as string) as { text: string }).text);
    // Call 3 failed; what reached the user is every other call, in order.
    const delivered = bodies.filter((_, i) => i !== 2);
    expect(delivered).toHaveLength(4);
    expect(delivered.join('')).toBe(text);
  });
});
