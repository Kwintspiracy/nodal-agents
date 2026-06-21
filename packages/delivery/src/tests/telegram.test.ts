// telegram.test.ts — sendTelegramMessage: fetch shape, error codes

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTelegramMessage } from '../channels/telegram.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_TOKEN = 'bot123:ABCDEF';
const FAKE_CHAT_ID = '987654321';

function makeFetchResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sendTelegramMessage', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to correct Telegram API URL', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 42 } }),
    );

    await sendTelegramMessage({
      chatId: FAKE_CHAT_ID,
      text: 'Hello',
      botToken: FAKE_TOKEN,
    });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
  });

  it('sends correct JSON body: chat_id, text, parse_mode', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );

    await sendTelegramMessage({
      chatId: FAKE_CHAT_ID,
      text: 'Test message',
      botToken: FAKE_TOKEN,
      parseMode: 'HTML',
      disableWebPagePreview: true,
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(init?.method).toBe('POST');
    const bodyText = init?.body as string;
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body['chat_id']).toBe(FAKE_CHAT_ID);
    expect(body['text']).toBe('Test message');
    expect(body['parse_mode']).toBe('HTML');
    expect(body['disable_web_page_preview']).toBe(true);
  });

  it('returns the message_id from the response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 999 } }),
    );

    const result = await sendTelegramMessage({
      chatId: FAKE_CHAT_ID,
      text: 'Hello',
      botToken: FAKE_TOKEN,
    });

    expect(result.messageId).toBe(999);
  });

  it('does NOT include parse_mode when not provided', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: { message_id: 1 } }),
    );

    await sendTelegramMessage({
      chatId: FAKE_CHAT_ID,
      text: 'Hello',
      botToken: FAKE_TOKEN,
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect('parse_mode' in body).toBe(false);
  });

  it('throws telegram_unauthorized on 401', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(
      sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'x', botToken: 'bad' }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_unauthorized';
    });
  });

  it('throws telegram_rate_limited on 429', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(429, { ok: false, description: 'Too Many Requests' }),
    );

    await expect(
      sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'x', botToken: FAKE_TOKEN }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_rate_limited';
    });
  });

  it('throws telegram_chat_not_found on 400 "chat not found"', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(400, { ok: false, description: 'Bad Request: chat not found' }),
    );

    await expect(
      sendTelegramMessage({ chatId: '000', text: 'x', botToken: FAKE_TOKEN }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_chat_not_found';
    });
  });

  it('throws telegram_request_failed on other 400 errors', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(400, { ok: false, description: 'Bad Request: some other error' }),
    );

    await expect(
      sendTelegramMessage({ chatId: '000', text: 'x', botToken: FAKE_TOKEN }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_request_failed';
    });
  });

  it('throws telegram_request_failed on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('Network failure'));

    await expect(
      sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'x', botToken: FAKE_TOKEN }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_request_failed';
    });
  });

  // ── Chunking: messages > 4096 must be split, not rejected as "too long" ──────
  it('sends a single request when the text fits under the limit', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 1 } })),
    );
    await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'short', botToken: FAKE_TOKEN });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
  });

  it('splits an oversized message into multiple sends, each within the limit', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 7 } })),
    );
    // 15_000 chars across many lines (the real-world 15_480 "too long" case).
    const longText = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(45)}`).join(
      '\n',
    );
    expect(longText.length).toBeGreaterThan(4096);

    const res = await sendTelegramMessage({
      chatId: FAKE_CHAT_ID,
      text: longText,
      botToken: FAKE_TOKEN,
    });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [, init] of calls) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect((body['text'] as string).length).toBeLessThanOrEqual(4096);
    }
    // No content lost: concatenating the chunks reconstructs the original lines.
    const sent = calls
      .map(([, init]) => JSON.parse(init?.body as string)['text'] as string)
      .join('\n');
    expect(sent).toBe(longText);
    expect(res.messageId).toBe(7); // returns the LAST message id
  });

  it('hard-splits a single line longer than the limit', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 1 } })),
    );
    const oneHugeLine = 'y'.repeat(10_000);
    await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: oneHugeLine, botToken: FAKE_TOKEN });
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [, init] of calls) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect((body['text'] as string).length).toBeLessThanOrEqual(4096);
    }
  });
});
