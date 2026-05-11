// @nodalai/adapter-airtable — client factory and auth header tests

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
    expect(() => createAirtableClient(FAKE_TOKEN)).not.toThrow();
  });

  it('creates distinct client instances per call', () => {
    const a = createAirtableClient('token-a');
    const b = createAirtableClient('token-b');
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

    const client = createAirtableClient(FAKE_TOKEN);
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

    const client = createAirtableClient(FAKE_TOKEN);
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
    await createAirtableClient(OAUTH_TOKEN).get('/meta/bases');

    vi.stubGlobal('fetch', makeStub(capturedB));
    await createAirtableClient(PAT).get('/meta/bases');

    vi.restoreAllMocks();

    expect(capturedA[0]).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(capturedB[0]).toBe(`Bearer ${PAT}`);
    expect(capturedA[0]?.startsWith('Bearer ')).toBe(true);
    expect(capturedB[0]?.startsWith('Bearer ')).toBe(true);
  });
});

describe('createAirtableClient — error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws AirtableApiError with unauthorized on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(401, 'Unauthorized')));

    const client = createAirtableClient(FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError &&
        err.code === 'airtable_unauthorized' &&
        err.status === 401,
    );
  });

  it('throws AirtableApiError with not_found on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(404, 'Not found')));

    const client = createAirtableClient(FAKE_TOKEN);
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

    const client = createAirtableClient(FAKE_TOKEN);
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

    const client = createAirtableClient(FAKE_TOKEN);
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

    const client = createAirtableClient(FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError && err.code === 'airtable_transient' && err.status === 503,
    );
  });

  it('throws AirtableApiError with client_error on 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeErrorResponse(400, 'Bad request')));

    const client = createAirtableClient(FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AirtableApiError &&
        err.code === 'airtable_client_error' &&
        err.status === 400,
    );
  });

  it('wraps network errors in AirtableApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const client = createAirtableClient(FAKE_TOKEN);
    await expect(client.get('/meta/bases')).rejects.toSatisfy(
      (err: unknown) => err instanceof AirtableApiError && err.code === 'airtable_unknown',
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

    const client = createAirtableClient(FAKE_TOKEN);
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

    const client = createAirtableClient(FAKE_TOKEN);
    await client.get('/appXXX/tblXXX');

    expect(capturedUrls[0]).toContain('api.airtable.com/v0/appXXX/tblXXX');
  });
});
