// @nodal-agents/adapter-poyo — client tests (fetch injected, no network).
// Asserts on the real request shape and the normalised response, not call counts.

import { describe, it, expect, vi } from 'vitest';
import { createPoyoClient } from '../client.ts';
import { PoyoApiError } from '../errors.ts';

const TOKEN = 'poyo-fake-token-123';
const BASE = 'https://api.poyo.test';

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

type Call = [string, RequestInit | undefined];

describe('createPoyoClient — submit', () => {
  it('POSTs { model, input } with the bearer header and returns data.task_id', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(200, { code: 200, data: { task_id: 'task-abc' } }),
    );
    const client = createPoyoClient(TOKEN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: BASE,
    });

    const taskId = await client.submit('gpt-4o-image', { prompt: 'a cat', size: '1:1' });

    expect(taskId).toBe('task-abc');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as Call;
    expect(url).toBe(`${BASE}/api/generate/submit`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'gpt-4o-image',
      input: { prompt: 'a cat', size: '1:1' },
    });
  });

  it('throws poyo_unauthorized on 401', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(401, 'unauthorized'));
    const client = createPoyoClient(TOKEN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.submit('gpt-4o-image', { prompt: 'x' })).rejects.toSatisfy(
      (e: unknown) => e instanceof PoyoApiError && e.code === 'poyo_unauthorized',
    );
  });

  it('throws poyo_unknown when the response has no task_id', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { code: 200, data: {} }));
    const client = createPoyoClient(TOKEN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.submit('gpt-4o-image', { prompt: 'x' })).rejects.toSatisfy(
      (e: unknown) => e instanceof PoyoApiError && e.code === 'poyo_unknown',
    );
  });
});

// audit#2 M-15: a fetch that accepts the connection but never responds must
// time out with a clear error instead of hanging the tool call forever.
describe('createPoyoClient — timeout (M-15)', () => {
  function hangingFetchImpl(): typeof fetch {
    return vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      });
    }) as unknown as typeof fetch;
  }

  it('submit() times out and throws a clear PoyoApiError when the endpoint never responds', async () => {
    const client = createPoyoClient(TOKEN, {
      fetchImpl: hangingFetchImpl(),
      baseUrl: BASE,
      timeoutMs: 30,
    });

    await expect(client.submit('gpt-4o-image', { prompt: 'x' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PoyoApiError && e.code === 'poyo_transient' && /timed out/i.test(e.message),
    );
  });

  it('status() times out and throws a clear PoyoApiError when the endpoint never responds', async () => {
    const client = createPoyoClient(TOKEN, {
      fetchImpl: hangingFetchImpl(),
      baseUrl: BASE,
      timeoutMs: 30,
    });

    await expect(client.status('task-abc')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PoyoApiError && e.code === 'poyo_transient' && /timed out/i.test(e.message),
    );
  });
});

describe('createPoyoClient — status', () => {
  it('GETs the task and normalises files[].file_url → files[].url', async () => {
    const body = {
      code: 200,
      data: {
        status: 'finished',
        progress: 100,
        files: [{ file_url: 'https://storage.poyo.test/i.jpg', file_type: 'image' }],
      },
    };
    const fetchImpl = vi.fn(async () => fakeResponse(200, body));
    const client = createPoyoClient(TOKEN, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: BASE,
    });

    const status = await client.status('task-abc');

    expect(status).toEqual({
      status: 'finished',
      progress: 100,
      files: [{ url: 'https://storage.poyo.test/i.jpg', type: 'image' }],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as Call;
    expect(url).toBe(`${BASE}/api/generate/status/task-abc`);
    expect(init?.method).toBe('GET');
  });

  it('throws poyo_transient on 500', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, 'server error'));
    const client = createPoyoClient(TOKEN, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.status('task-abc')).rejects.toSatisfy(
      (e: unknown) => e instanceof PoyoApiError && e.code === 'poyo_transient',
    );
  });
});
