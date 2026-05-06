// telegram-config.test.ts — bot config helpers for the long-polling pipeline.
//
// Covers: getTelegramBotInfo (token validation via getMe) and
// getTelegramUpdates (long-polling for new messages).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTelegramBotInfo, getTelegramUpdates } from '../channels/telegram.ts';
import { DeliveryError } from '../errors.ts';

const FAKE_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeFetchResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getTelegramBotInfo', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hits the getMe endpoint with the right URL', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, {
        ok: true,
        result: {
          id: 123,
          is_bot: true,
          first_name: 'My Bot',
          username: 'my_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
        },
      }),
    );

    const info = await getTelegramBotInfo(FAKE_TOKEN);

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getMe`);
    expect(info).toEqual({
      id: 123,
      username: 'my_bot',
      firstName: 'My Bot',
      canJoinGroups: true,
      canReadAllGroupMessages: false,
    });
  });

  it('throws telegram_invalid_token on 401', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(getTelegramBotInfo('bad-token')).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_invalid_token';
    });
  });

  it('throws telegram_invalid_token on 404 (well-formed but unknown bot)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(404, { ok: false, description: 'Not Found' }),
    );

    await expect(getTelegramBotInfo('123:abc')).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_invalid_token';
    });
  });

  it('throws telegram_request_failed on network error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('boom'));

    await expect(getTelegramBotInfo(FAKE_TOKEN)).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_request_failed';
    });
  });
});

describe('getTelegramUpdates', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts offset + timeout + allowed_updates to getUpdates', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: [] }),
    );

    await getTelegramUpdates({ botToken: FAKE_TOKEN, offset: 42, timeout: 30 });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['offset']).toBe(42);
    expect(body['timeout']).toBe(30);
    expect(body['allowed_updates']).toEqual(['message', 'callback_query']);
  });

  it('defaults timeout to 25 when not specified', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: [] }),
    );

    await getTelegramUpdates({ botToken: FAKE_TOKEN, offset: 0 });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['timeout']).toBe(25);
  });

  it('returns the array of updates from the response', async () => {
    const updates = [
      {
        update_id: 100,
        message: {
          message_id: 1,
          chat: { id: 555, type: 'private' },
          from: { id: 7, first_name: 'A', is_bot: false },
          text: 'hello',
        },
      },
      {
        update_id: 101,
        message: {
          message_id: 2,
          chat: { id: 555, type: 'private' },
          from: { id: 7, first_name: 'A', is_bot: false },
          text: 'world',
        },
      },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: updates }),
    );

    const result = await getTelegramUpdates({ botToken: FAKE_TOKEN, offset: 99 });
    expect(result).toEqual(updates);
  });

  it('returns empty array when no updates pending', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: [] }),
    );

    const result = await getTelegramUpdates({ botToken: FAKE_TOKEN, offset: 0 });
    expect(result).toEqual([]);
  });

  it('throws telegram_invalid_token on 401 (re-poll loop must stop on this)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(getTelegramUpdates({ botToken: 'bad', offset: 0 })).rejects.toSatisfy(
      (err: unknown) => {
        return err instanceof DeliveryError && err.code === 'telegram_invalid_token';
      },
    );
  });

  it('passes limit when provided (used by configure-time backlog drain)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: [] }),
    );

    await getTelegramUpdates({
      botToken: FAKE_TOKEN,
      offset: -1,
      timeout: 0,
      limit: 1,
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['limit']).toBe(1);
    expect(body['offset']).toBe(-1);
    expect(body['timeout']).toBe(0);
  });

  it('does NOT include limit when not specified (default polling)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(200, { ok: true, result: [] }),
    );

    await getTelegramUpdates({ botToken: FAKE_TOKEN, offset: 0 });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect('limit' in body).toBe(false);
  });

  it('throws telegram_request_failed on transient errors (caller backs off and retries)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(500, { ok: false, description: 'Internal Server Error' }),
    );

    await expect(getTelegramUpdates({ botToken: FAKE_TOKEN, offset: 0 })).rejects.toSatisfy(
      (err: unknown) => {
        return err instanceof DeliveryError && err.code === 'telegram_request_failed';
      },
    );
  });
});
