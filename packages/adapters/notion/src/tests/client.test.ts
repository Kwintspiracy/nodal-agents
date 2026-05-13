// @nodal-agents/adapter-notion — client factory tests

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createNotionClient } from '../client';
import { Client } from '@notionhq/client';

describe('createNotionClient', () => {
  it('returns a @notionhq/client Client instance', () => {
    const client = createNotionClient('secret_test_key');
    expect(client).toBeInstanceOf(Client);
  });

  it('creates distinct instances per call', () => {
    const a = createNotionClient('secret_key_a');
    const b = createNotionClient('secret_key_b');
    expect(a).not.toBe(b);
  });

  it('accepts any non-empty string as apiKey (validation is API-side)', () => {
    // Should not throw — Notion validates the key at request time
    expect(() => createNotionClient('any-key')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bearer header tests — verify the SDK sends the correct Authorization header
// for both apiKey (Internal Integration) and accessToken (OAuth) paths.
// ---------------------------------------------------------------------------

describe('createNotionClient — Authorization header on outgoing requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Authorization: Bearer <apiKey> when constructed with an Internal Integration key', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    // Mock fetch to capture headers and return a minimal valid Notion API response
    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return Promise.resolve(
        new Response(
          JSON.stringify({ object: 'list', results: [], next_cursor: null, has_more: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    const API_KEY = 'secret_internal_integration_key';
    // Pass our mock fetch into the SDK via its `fetch` option
    const client = new Client({ auth: API_KEY, fetch: mockFetch as typeof fetch });

    // Trigger a real SDK request so the header is populated
    await client.search({ query: 'test' });

    expect(capturedHeaders.length).toBeGreaterThan(0);
    const authHeader = capturedHeaders[0]?.['authorization'] ?? '';
    expect(authHeader).toBe(`Bearer ${API_KEY}`);
  });

  it('sends Authorization: Bearer <accessToken> when constructed with an OAuth access token', async () => {
    const capturedHeaders: Record<string, string>[] = [];

    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return Promise.resolve(
        new Response(
          JSON.stringify({ object: 'list', results: [], next_cursor: null, has_more: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });

    const ACCESS_TOKEN = 'oauth_access_token_from_public_integration';
    const client = new Client({ auth: ACCESS_TOKEN, fetch: mockFetch as typeof fetch });

    await client.search({ query: 'test' });

    expect(capturedHeaders.length).toBeGreaterThan(0);
    const authHeader = capturedHeaders[0]?.['authorization'] ?? '';
    expect(authHeader).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('apiKey and accessToken paths produce identical Authorization header format (modulo token value)', async () => {
    const headersForApiKey: Record<string, string>[] = [];
    const headersForToken: Record<string, string>[] = [];

    const makeMock = (sink: Record<string, string>[]) =>
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        sink.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return Promise.resolve(
          new Response(
            JSON.stringify({ object: 'list', results: [], next_cursor: null, has_more: false }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      });

    const KEY = 'secret_key_value';
    const TOKEN = 'oauth_token_value';

    const clientByKey = new Client({
      auth: KEY,
      fetch: makeMock(headersForApiKey) as typeof fetch,
    });
    const clientByToken = new Client({
      auth: TOKEN,
      fetch: makeMock(headersForToken) as typeof fetch,
    });

    await clientByKey.search({ query: 'ping' });
    await clientByToken.search({ query: 'ping' });

    const authByKey = headersForApiKey[0]?.['authorization'] ?? '';
    const authByToken = headersForToken[0]?.['authorization'] ?? '';

    // Both must use "Bearer " prefix — identical wire format, different values
    expect(authByKey).toBe(`Bearer ${KEY}`);
    expect(authByToken).toBe(`Bearer ${TOKEN}`);
    expect(authByKey.startsWith('Bearer ')).toBe(true);
    expect(authByToken.startsWith('Bearer ')).toBe(true);
  });
});
