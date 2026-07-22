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

  it('throws telegram_rate_limited once 429 retries are exhausted (F-4: 429s are now retried, not failed immediately)', async () => {
    vi.useFakeTimers();
    try {
      // A fresh Response per call — a Response body can only be read once, and
      // mockResolvedValue would otherwise hand back the same already-read instance.
      vi.mocked(globalThis.fetch).mockImplementation(() =>
        Promise.resolve(makeFetchResponse(429, { ok: false, description: 'Too Many Requests' })),
      );

      const pending = sendTelegramMessage({
        chatId: FAKE_CHAT_ID,
        text: 'x',
        botToken: FAKE_TOKEN,
      });
      const assertion = expect(pending).rejects.toSatisfy((err: unknown) => {
        return err instanceof DeliveryError && err.code === 'telegram_rate_limited';
      });
      // Every 429 retry backs off (no retry_after in this response, so the
      // default backoff escalates); run all pending timers until it gives up.
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  it('flags mayHaveDelivered=true on a send timeout (AbortError), and NOT on plain network errors', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(abortErr);

    await expect(
      sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'x', botToken: FAKE_TOKEN }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DeliveryError &&
        err.mayHaveDelivered === true &&
        err.message.includes('telegram_timeout')
      );
    });

    // Control: a non-timeout network error must NOT carry the flag — retrying
    // those is safe and the LLM should stay free to do it.
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: 'x', botToken: FAKE_TOKEN }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.mayHaveDelivered === undefined;
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

  // ── F-16: chunkForTelegram edge cases ───────────────────────────────────────
  it('does not emit an empty leading chunk when the first line is exactly `max` chars', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 1 } })),
    );
    // Before the fix: current.length(0) + line.length(max) + 1 > max is always
    // true, so the (empty) `current` got pushed as its own chunk first —
    // Telegram rejects an empty message with a 400.
    const max = 3900;
    const firstLine = 'a'.repeat(max);
    const text = `${firstLine}\nsecond line`;
    await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text, botToken: FAKE_TOKEN });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const sentTexts = calls.map(
      ([, init]) => (JSON.parse(init?.body as string) as { text: string }).text,
    );
    expect(sentTexts.every((t) => t.length > 0)).toBe(true);
    expect(sentTexts[0]).toBe(firstLine);
    expect(sentTexts[1]).toBe('second line');
  });

  it('does not split a surrogate pair (emoji) across two hard-split chunks', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 1 } })),
    );
    // A single "line" of emoji (each 2 UTF-16 code units), long enough to force
    // a hard split. The 1-char odd-length prefix shifts every emoji pair onto
    // an odd/even boundary so the default cap (3900, even) lands EXACTLY
    // between a high and low surrogate — a naive `slice(i, i+max)` would
    // corrupt both resulting chunks here.
    const emoji = '😀'; // U+1F600, 2 code units: high surrogate + low surrogate
    const longLine = 'x' + emoji.repeat(3000); // 6001 code units, well over the 3900 cap
    await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: longLine, botToken: FAKE_TOKEN });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const sentTexts = calls.map(
      ([, init]) => (JSON.parse(init?.body as string) as { text: string }).text,
    );
    expect(sentTexts.length).toBeGreaterThan(1);
    for (const chunk of sentTexts) {
      // No isolated high surrogate at the end, no isolated low surrogate at the start.
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      const firstCode = chunk.charCodeAt(0);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
    }
    // No content lost or corrupted: rejoining reconstructs the original emoji run.
    expect(sentTexts.join('')).toBe(longLine);
  });

  // ── F-4: 429 backoff + partial-progress on chunked sends ────────────────────
  it("honors Telegram's retry_after on 429 before retrying the chunk", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.mocked(globalThis.fetch).mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            makeFetchResponse(429, {
              ok: false,
              description: 'Too Many Requests: retry after 2',
              parameters: { retry_after: 2 },
            }),
          );
        }
        return Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 5 } }));
      });

      const promise = sendTelegramMessage({
        chatId: FAKE_CHAT_ID,
        text: 'hi',
        botToken: FAKE_TOKEN,
      });
      // Let the first (429) attempt resolve and schedule the backoff timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1); // hasn't retried yet — waiting out retry_after
      // Advancing by less than retry_after must NOT trigger the retry yet.
      await vi.advanceTimersByTimeAsync(1900);
      expect(calls).toBe(1);
      // Advancing past the full 2s retry_after triggers the retry.
      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;
      expect(calls).toBe(2);
      expect(result.messageId).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps an excessive retry_after instead of trusting Telegram's value unbounded", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.mocked(globalThis.fetch).mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            makeFetchResponse(429, {
              ok: false,
              description: 'Too Many Requests: retry after 3600',
              parameters: { retry_after: 3600 }, // 1 hour — must be capped
            }),
          );
        }
        return Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: 9 } }));
      });

      const promise = sendTelegramMessage({
        chatId: FAKE_CHAT_ID,
        text: 'hi',
        botToken: FAKE_TOKEN,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      // Just under the 60s cap: must NOT have retried yet.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(calls).toBe(1);
      // Past the 60s cap: retries even though Telegram asked for a full hour.
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(calls).toBe(2);
      expect(result.messageId).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resend already-delivered chunks when a caller resumes after a partial failure', async () => {
    // A long text that splits into several chunks. Chunk 0 succeeds, chunk 1
    // throws (non-retryable 500). The thrown DeliveryError must report exactly
    // 1 chunk already sent, and a caller that retries with startChunkIndex
    // must not re-send chunk 0.
    const longText = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(45)}`).join(
      '\n',
    );

    let call = 0;
    vi.mocked(globalThis.fetch).mockImplementation(() => {
      call += 1;
      if (call === 2) {
        return Promise.resolve(makeFetchResponse(500, { ok: false, description: 'boom' }));
      }
      return Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: call } }));
    });

    let caught: DeliveryError | undefined;
    try {
      await sendTelegramMessage({ chatId: FAKE_CHAT_ID, text: longText, botToken: FAKE_TOKEN });
      expect.fail('expected sendTelegramMessage to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryError);
      caught = err as DeliveryError;
    }

    expect(caught?.code).toBe('telegram_request_failed');
    expect(caught?.partialProgress?.sentChunks).toBe(1);
    const totalChunks = caught!.partialProgress!.totalChunks;
    expect(totalChunks).toBeGreaterThan(1);

    const callsAfterFirstAttempt = vi.mocked(globalThis.fetch).mock.calls.length;
    expect(callsAfterFirstAttempt).toBe(2); // chunk 0 (sent) + chunk 1 (threw); chunk 2+ never attempted

    // Retry, resuming from the reported sentChunks — chunk 0 must NOT be sent again.
    vi.mocked(globalThis.fetch).mockImplementation(() => {
      call += 1;
      return Promise.resolve(makeFetchResponse(200, { ok: true, result: { message_id: call } }));
    });
    await sendTelegramMessage({
      chatId: FAKE_CHAT_ID,
      text: longText,
      botToken: FAKE_TOKEN,
      startChunkIndex: caught!.partialProgress!.sentChunks,
    });

    const callsOnRetry = vi.mocked(globalThis.fetch).mock.calls.length - callsAfterFirstAttempt;
    // Only the remaining chunks (from index 1 onward) were sent on the retry —
    // chunk 0 (already delivered) is not among them.
    expect(callsOnRetry).toBe(totalChunks - 1);
  });
});
