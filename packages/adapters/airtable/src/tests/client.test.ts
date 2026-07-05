// @nodal-agents/adapter-airtable — client factory and auth header tests

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAirtableClient } from '../client.ts';
import { AirtableApiError } from '../errors.ts';

const FAKE_TOKEN = 'pat_fake_access_token_123';

// Minimal success responses for various endpoints
function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createAirtableClient — instantiation', () => {
  it('creates a client without throwing', () => {
    expect(() => createAirtableClient(async () => FAKE_TOKEN)).not.toThrow();
  });

  it('creates distinct client instances per call', () => {
    const a = createAirtableClient(async () => 'token-a');
    const b = createAirtableClient(async () => 'token-b');
    expect(a).not.toBe(b);
  });
});

describe('createAirtableClient — Authorization header', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Authorization: Bearer <token> on GET requests', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return Promise.resolve(makeOkResponse({ bases: [] }));
      }),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await client.get('/meta/bases');

    expect(capturedHeaders.length).toBeGreaterThan(0);
    expect(capturedHeaders[0]?.['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('sends Authorization: Bearer <token> on POST requests', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return Promise.resolve(makeOkResponse({ records: [] }));
      }),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await client.post('/appXXX/tblXXX', { records: [] });

    expect(capturedHeaders[0]?.['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('OAuth token and PAT produce identical Authorization header format', async () => {
    const capturedA: string[] = [];
    const capturedB: string[] = [];

    const makeStub = (sink: string[]) =>
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const h = Object.fromEntries(new Headers(init?.headers).entries());
        sink.push(h['authorization'] ?? '');
        return Promise.resolve(makeOkResponse({ bases: [] }));
      });

    const OAUTH_TOKEN = 'oauth_at_abc123';
    const PAT =
      'patXXXXXXXXXXXXXX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

    vi.stubGlobal('fetch', makeStub(capturedA));
    await createAirtableClient(async () => OAUTH_TOKEN).get('/meta/bases');

    vi.stubGlobal('fetch', makeStub(capturedB));
    await createAirtableClient(async () => PAT).get('/meta/bases');

    vi.restoreAllMocks();

    expect(capturedA[0]).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(capturedB[0]).toBe(`Bearer ${PAT}`);
    expect(capturedA[0]?.startsWith('Bearer ')).toBe(true);
    expect(capturedB[0]?.startsWith('Bearer ')).toBe(true);
  });

  // audit#2 M-12: Airtable OAuth2 access tokens live ~60min; a job can run
  // far longer (IDLE_RESET is 4h). Before the fix, createAirtableClient
  // captured a single accessToken string at construction — a resolver was
  // never called again, so a mid-job token refresh could never reach a
  // request. This test would have failed before the fix: there was no
  // getAccessToken parameter at all, so the SECOND request could not possibly
  // observe a different token than the first.
  it('re-invokes getAccessToken on every request, not just at construction', async () => {
    let calls = 0;
    const getAccessToken = async (): Promise<string> => {
      calls++;
      return `token-${calls}`;
    };

    const capturedHeaders: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const h = Object.fromEntries(new Headers(init?.headers).entries());
        capturedHeaders.push(h['authorization'] ?? '');
        return Promise.resolve(makeOkResponse({ bases: [] }));
      }),
    );

    const client = createAirtableClient(getAccessToken);
    await client.get('/meta/bases');
    await client.get('/meta/bases');

    expect(calls).toBe(2);
    expect(capturedHeaders[0]).toBe('Bearer token-1');
    expect(capturedHeaders[1]).toBe('Bearer token-2');
  });
});

describe('createAirtableClient — error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws AirtableApiError with unauthorized on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'Unauthorized')));

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError &&
        err.code === 'airtable_unauthorized' &&
        err.status === 401,
    );
  });

  it('throws AirtableApiError with not_found on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(404, 'Not found')));

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.get('/appXXX/tblXXX/recXXX')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError && err.code === 'airtable_not_found' && err.status === 404,
    );
  });

  it('throws AirtableApiError with validation_error on 422', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeErrorResponse(422, 'Invalid field value')),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.post('/appXXX/tblXXX', {})).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError &&
        err.code === 'airtable_validation_error' &&
        err.status === 422,
    );
  });

  it('throws AirtableApiError with transient on 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeErrorResponse(500, 'Internal Server Error')),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError && err.code === 'airtable_transient' && err.status === 500,
    );
  });

  it('throws AirtableApiError with transient on 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeErrorResponse(503, 'Service Unavailable')),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError && err.code === 'airtable_transient' && err.status === 503,
    );
  });

  it('throws AirtableApiError with client_error on 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(400, 'Bad request')));

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError &&
        err.code === 'airtable_client_error' &&
        err.status === 400,
    );
  });

  it('wraps network errors in AirtableApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) => err instanceof AirtableApiError && err.code === 'airtable_unknown',
    );
  });

  // audit#2 M-15: an endpoint that accepts the connection but never responds
  // must time out with a clear error instead of hanging the tool call forever.
  it('times out and throws a clear AirtableApiError when the endpoint never responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          });
        });
      }),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN, { timeoutMs: 30 });
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError &&
        err.code === 'airtable_transient' &&
        /timed out/i.test(err.message),
    );
  });
});

describe('createAirtableClient — URL building', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes /meta/ paths under /v0/ (api.airtable.com/v0/meta/...)', async () => {
    // Regression: all Airtable endpoints, including /meta/bases, live under /v0/.
    // An earlier version of this adapter mistakenly split /meta/ paths off to
    // https://api.airtable.com (no /v0/), which returned 404 when calling
    // airtable_list_bases. The corrected wire path is api.airtable.com/v0/meta/...
    const capturedUrls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        return Promise.resolve(makeOkResponse({ bases: [] }));
      }),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await client.get('/meta/bases');

    expect(capturedUrls[0]).toContain('api.airtable.com/v0/meta/bases');
  });

  it('uses BASE_URL (api.airtable.com/v0) for record paths', async () => {
    const capturedUrls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        return Promise.resolve(makeOkResponse({ records: [] }));
      }),
    );

    const client = createAirtableClient(async () => FAKE_TOKEN);
    await client.get('/appXXX/tblXXX');

    expect(capturedUrls[0]).toContain('api.airtable.com/v0/appXXX/tblXXX');
  });
});
