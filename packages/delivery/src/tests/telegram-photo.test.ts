// telegram-photo.test.ts — sendTelegramPhoto: fetch shape, error codes, token redaction

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTelegramPhoto } from '../channels/telegram.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_TOKEN = 'bot123:ABCDEF';
const FAKE_CHAT_ID = '987654321';
const FAKE_PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

function makeFetchResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sendTelegramPhoto', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the correct Telegram API URL (sendPhoto)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 42 } }),
    );

    await sendTelegramPhoto({ chatId: FAKE_CHAT_ID, botToken: FAKE_TOKEN, photo: FAKE_PHOTO });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendPhoto`);
  });

  it('sends FormData with chat_id and photo fields', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 7 } }),
    );

    await sendTelegramPhoto({
      chatId: FAKE_CHAT_ID,
      botToken: FAKE_TOKEN,
      photo: FAKE_PHOTO,
      filename: 'test.png',
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(init?.method).toBe('POST');
    // Content-Type must NOT be set manually — fetch sets the multipart boundary
    expect((init?.headers as Record<string, string> | undefined)?.['Content-Type']).toBeUndefined();
    // Body should be FormData
    expect(init?.body).toBeInstanceOf(FormData);
    const fd = init!.body as FormData;
    expect(fd.get('chat_id')).toBe(FAKE_CHAT_ID);
    expect(fd.get('photo')).toBeInstanceOf(Blob);
  });

  it('includes caption when provided, sliced to 1024 chars', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );

    const longCaption = 'A'.repeat(2000);
    await sendTelegramPhoto({
      chatId: FAKE_CHAT_ID,
      botToken: FAKE_TOKEN,
      photo: FAKE_PHOTO,
      caption: longCaption,
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const fd = init!.body as FormData;
    const captionVal = fd.get('caption') as string;
    expect(captionVal).toHaveLength(1024);
  });

  it('does NOT include caption field when not provided', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );

    await sendTelegramPhoto({ chatId: FAKE_CHAT_ID, botToken: FAKE_TOKEN, photo: FAKE_PHOTO });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const fd = init!.body as FormData;
    expect(fd.get('caption')).toBeNull();
  });

  it('returns the messageId from the response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 99 } }),
    );

    const result = await sendTelegramPhoto({
      chatId: FAKE_CHAT_ID,
      botToken: FAKE_TOKEN,
      photo: FAKE_PHOTO,
    });

    expect(result.messageId).toBe(99);
  });

  it('throws telegram_unauthorized on 401', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(
      sendTelegramPhoto({ chatId: FAKE_CHAT_ID, botToken: 'bad', photo: FAKE_PHOTO }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_unauthorized';
    });
  });

  it('throws telegram_rate_limited on 429', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(429, { ok: false, description: 'Too Many Requests' }),
    );

    await expect(
      sendTelegramPhoto({ chatId: FAKE_CHAT_ID, botToken: FAKE_TOKEN, photo: FAKE_PHOTO }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_rate_limited';
    });
  });

  it('throws telegram_chat_not_found on 400 "chat not found"', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(400, { ok: false, description: 'Bad Request: chat not found' }),
    );

    await expect(
      sendTelegramPhoto({ chatId: '000', botToken: FAKE_TOKEN, photo: FAKE_PHOTO }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_chat_not_found';
    });
  });

  it('throws telegram_request_failed on other errors', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(500, { ok: false, description: 'Internal Server Error' }),
    );

    await expect(
      sendTelegramPhoto({ chatId: FAKE_CHAT_ID, botToken: FAKE_TOKEN, photo: FAKE_PHOTO }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_request_failed';
    });
  });

  it('redacts the bot token from network error messages', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(
      new Error(`ECONNREFUSED bot123:ABCDEF at 1.2.3.4`),
    );

    await expect(
      sendTelegramPhoto({ chatId: FAKE_CHAT_ID, botToken: FAKE_TOKEN, photo: FAKE_PHOTO }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DeliveryError &&
        err.code === 'telegram_request_failed' &&
        !err.message.includes(FAKE_TOKEN)
      );
    });
  });
});
