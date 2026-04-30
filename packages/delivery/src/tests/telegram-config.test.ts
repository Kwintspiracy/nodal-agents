// telegram-config.test.ts — getTelegramBotInfo / setTelegramWebhook /
// deleteTelegramWebhook: fetch shape, response parsing, error mapping.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTelegramBotInfo,
  setTelegramWebhook,
  deleteTelegramWebhook,
} from '../channels/telegram.ts';
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

describe('setTelegramWebhook', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts url + secret_token + allowed_updates to setWebhook', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeFetchResponse(200, { ok: true, result: true }));

    await setTelegramWebhook({
      botToken: FAKE_TOKEN,
      url: 'https://example.com/api/telegram?agent_slug=foo',
      secretToken: 'sekret',
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/setWebhook`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['url']).toBe('https://example.com/api/telegram?agent_slug=foo');
    expect(body['secret_token']).toBe('sekret');
    expect(body['allowed_updates']).toEqual(['message', 'callback_query']);
  });

  it('throws telegram_invalid_token on bad bot token (401)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(
      setTelegramWebhook({ botToken: 'bad', url: 'https://x/y', secretToken: 's' }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_invalid_token';
    });
  });

  it('wraps other errors as telegram_webhook_failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(400, { ok: false, description: 'Bad Request: bad webhook' }),
    );

    await expect(
      setTelegramWebhook({ botToken: FAKE_TOKEN, url: 'http://localhost/y', secretToken: 's' }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_webhook_failed';
    });
  });
});

describe('deleteTelegramWebhook', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hits deleteWebhook with drop_pending_updates=false', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeFetchResponse(200, { ok: true, result: true }));

    await deleteTelegramWebhook(FAKE_TOKEN);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/deleteWebhook`);
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['drop_pending_updates']).toBe(false);
  });

  it('throws telegram_invalid_token on bad bot token', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      makeFetchResponse(401, { ok: false, description: 'Unauthorized' }),
    );

    await expect(deleteTelegramWebhook('bad')).rejects.toSatisfy((err: unknown) => {
      return err instanceof DeliveryError && err.code === 'telegram_invalid_token';
    });
  });
});
