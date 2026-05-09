// @vitest-environment node
// oauth-callback.test.ts — integration tests for GET /api/oauth/[provider]/callback
//
// Tests the route handler directly (imported as a function) to avoid spinning
// up a real HTTP server. Uses pglite + seedMinimal for a real DB.
//
// Must run in 'node' environment (not jsdom) because pglite uses native
// Node APIs (Blob.arrayBuffer, WASM) unavailable in jsdom.
// Patterns mirrored from apps/web/tests/actions.test.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests, encrypt } from '@nodalai/secrets';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { connectors } from '@nodalai/db';
import { eq, and } from '@nodalai/db';

// ─── Module-level mock setup ──────────────────────────────────────────────────
// vi.mock calls are hoisted by Vitest to the top of the module.
// We use a mutable holder populated in beforeAll.

let _testDb: TestDb | null = null;
let _testEntityId = 'placeholder-entity-id';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock @/lib/server.ts — the callback route imports getAuthProvider from here.
vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({
    getSession: async (_req: Request) => ({
      userId: 'test-user-id',
      entityId: _testEntityId,
    }),
    handleAuthRequest: null,
  }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: 'test-user-id',
    entityId: _testEntityId,
  })),
  requireAuthWithEntity: vi.fn(),
  requireUser: vi.fn(),
  requireUserWithEntity: vi.fn(),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));

  const { db } = await spinUpTestDb();
  _testDb = db;

  const seed = await seedMinimal(db);
  _testEntityId = seed.entityId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildValidCookie(opts: {
  slug: string;
  entityId: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<{ cookieValue: string; state: string; codeVerifier: string }> {
  const { generatePkce, generateState, signStatePayload } = await import('@/lib/oauth-state.ts');
  const { codeVerifier } = generatePkce();
  const state = generateState();
  const clientSecret = opts.clientSecret ?? 'test-client-secret';
  const payload = {
    v: 1 as const,
    slug: opts.slug,
    entityId: opts.entityId,
    state,
    codeVerifier,
    clientId: opts.clientId ?? 'test-client-id',
    clientSecretEnc: encrypt(clientSecret),
    createdAt: Date.now(),
  };
  const cookieValue = signStatePayload(payload);
  return { cookieValue, state, codeVerifier };
}

function buildCallbackRequest(opts: {
  origin: string;
  slug: string;
  code: string;
  state: string;
  cookieValue: string;
}): Request {
  const url = new URL(`${opts.origin}/api/oauth/${opts.slug}/callback`);
  url.searchParams.set('code', opts.code);
  url.searchParams.set('state', opts.state);
  return new Request(url.toString(), {
    method: 'GET',
    headers: {
      cookie: `nodalai_oauth_state=${opts.cookieValue}`,
    },
  });
}

function mockSuccessfulGoogleFetch(
  overrides: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    email?: string;
  } = {},
): ReturnType<typeof vi.fn> {
  const {
    access_token = 'test-access-token',
    refresh_token = 'test-refresh-token',
    expires_in = 3600,
    email = 'test@example.com',
  } = overrides;

  let callCount = 0;
  return vi.fn().mockImplementation((url: string) => {
    callCount++;
    if (callCount === 1 || String(url).includes('/token')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token,
            refresh_token,
            expires_in,
            scope: 'https://www.googleapis.com/auth/drive openid email',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    // Userinfo call
    return Promise.resolve(
      new Response(JSON.stringify({ email, name: 'Test User', sub: '1234567890' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

const ORIGIN = 'http://localhost:3000';
const SLUG = 'google-drive';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/oauth/[provider]/callback — happy path', () => {
  it('redirects 302 to /connectors?connected=google-drive after successful exchange', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_HAPPY',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({ email: 'happy@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, {
      params: Promise.resolve({ provider: SLUG }),
    });

    vi.unstubAllGlobals();

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toBe(`${ORIGIN}/connectors?connected=${SLUG}`);
  });

  it('persists connector row with enc:v1: prefix on sensitive fields', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_ENCRYPT',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({
      access_token: 'enc-test-at',
      refresh_token: 'enc-test-rt',
      email: 'encrypt@example.com',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    // Raw DB select — assert ciphertext prefixes.
    const rows = await _testDb!
      .select()
      .from(connectors)
      .where(and(eq(connectors.entityId, _testEntityId), eq(connectors.slug, SLUG)));

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;

    expect(row.oauthClientSecret).toMatch(/^enc:v1:/);
    expect(row.oauthRefreshToken).toMatch(/^enc:v1:/);
    expect(row.oauthAccessToken).toMatch(/^enc:v1:/);

    // Account name persisted in plaintext (from userinfo mock).
    expect(row.oauthAccountName).toBe('encrypt@example.com');
  });
});

describe('GET /api/oauth/[provider]/callback — error cases', () => {
  it('redirects to /connectors?oauth_error=state_mismatch when query state ≠ cookie state', async () => {
    const { cookieValue } = await buildValidCookie({ slug: SLUG, entityId: _testEntityId });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_MISMATCH',
      state: 'WRONG_STATE_THAT_DOES_NOT_MATCH',
      cookieValue,
    });

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('oauth_error=state_mismatch');
  });

  it('redirects to /connectors?oauth_error=invalid_state when cookie is missing', async () => {
    const { state } = await buildValidCookie({ slug: SLUG, entityId: _testEntityId });
    const req = new Request(`${ORIGIN}/api/oauth/${SLUG}/callback?code=x&state=${state}`, {
      method: 'GET',
    });

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('oauth_error=invalid_state');
  });

  it('redirects to /connectors?oauth_error=token_exchange_failed when token endpoint returns 400', async () => {
    const { cookieValue, state } = await buildValidCookie({ slug: SLUG, entityId: _testEntityId });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'BAD_CODE',
      state,
      cookieValue,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('oauth_error=token_exchange_failed');
  });

  it('redirects to /connectors?oauth_error=unknown_provider for unknown slug', async () => {
    const req = new Request(`${ORIGIN}/api/oauth/no-such-provider/callback?code=x&state=y`, {
      method: 'GET',
      headers: { cookie: 'nodalai_oauth_state=x.y' },
    });

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, {
      params: Promise.resolve({ provider: 'no-such-provider' }),
    });

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('oauth_error=unknown_provider');
  });
});
