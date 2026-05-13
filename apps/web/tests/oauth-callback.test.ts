// @vitest-environment node
// oauth-callback.test.ts — integration tests for GET /api/oauth/[provider]/callback
//
// Brique 34 v3: the callback now persists a CREDENTIAL ROW (not a connector row)
// and redirects with ?credentialId={id} appended to the returnTo URL
// (or /credentials?created={id} when returnTo is absent from the state cookie).
//
// Tests the route handler directly (imported as a function) to avoid spinning
// up a real HTTP server. Uses pglite + seedMinimal for a real DB.
//
// Must run in 'node' environment (not jsdom) because pglite uses native Node APIs.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  _setMasterKeyForTests,
  _resetMasterKeyCacheForTests,
  encrypt,
  isEncrypted,
} from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { credentials } from '@nodal-agents/db';
import { eq } from '@nodal-agents/db';

// ─── Module-level mock setup ──────────────────────────────────────────────────

let _testDb: TestDb | null = null;
let _testUserId = 'placeholder-user-id';
let _testEntityId = 'placeholder-entity-id';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized');
    return _testDb;
  },
  getAuthProvider: () => ({
    getSession: async (_req: Request) => ({
      userId: _testUserId,
      entityId: _testEntityId,
    }),
    handleAuthRequest: null,
  }),
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
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
  _testUserId = seed.userId;
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
  credentialType?: string;
  returnTo?: string;
  name?: string;
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
    credentialType: opts.credentialType ?? 'google-oauth',
    ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
    ...(opts.name ? { name: opts.name } : {}),
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
  it('redirects 302 to /credentials?created={credentialId} when no returnTo', async () => {
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
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/credentials?created=');

    // Extract credentialId from redirect URL — must be a UUID.
    const u = new URL(location);
    const createdId = u.searchParams.get('created');
    expect(createdId).toBeTruthy();
    expect(createdId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('redirects to returnTo?credentialId=... when returnTo is set in state', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
      returnTo: '/connectors?connectorSlug=google-drive',
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_RETURNTO',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({ email: 'returnto@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, {
      params: Promise.resolve({ provider: SLUG }),
    });

    vi.unstubAllGlobals();

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    // Must preserve the existing ?connectorSlug= param AND append credentialId.
    expect(location).toContain('connectorSlug=google-drive');
    expect(location).toContain('credentialId=');
  });

  it('persists a credential row with enc:v1: payload prefix', async () => {
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
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    // Extract the created credential id from the redirect.
    const location = response.headers.get('location') ?? '';
    const u = new URL(location);
    const credentialId = u.searchParams.get('created');
    expect(credentialId).toBeTruthy();

    // Raw DB select — assert ciphertext prefix on payload column.
    const rows = await _testDb!.select().from(credentials).where(eq(credentials.id, credentialId!));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // payload must be encrypted at rest.
    expect(row.payload).toMatch(/^enc:v1:/);
    expect(isEncrypted(row.payload)).toBe(true);

    // type set correctly.
    expect(row.type).toBe('google-oauth');

    // owner is our test user.
    expect(row.ownerUserId).toBe(_testUserId);
  });

  it('uses name from state cookie if provided', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
      name: 'My Named Credential',
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_NAMED',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({ email: 'named@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    const location = response.headers.get('location') ?? '';
    const u = new URL(location);
    const credentialId = u.searchParams.get('created');
    expect(credentialId).toBeTruthy();

    const rows = await _testDb!.select().from(credentials).where(eq(credentials.id, credentialId!));
    expect(rows[0]?.name).toBe('My Named Credential');
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

  it('forwards the provider OAuth error code and error_description as detail', async () => {
    const { cookieValue, state } = await buildValidCookie({ slug: SLUG, entityId: _testEntityId });
    const errorDescription =
      'Your OAuth application requested the scope "data.records:read" which your application does not have access to.';
    const url = new URL(`${ORIGIN}/api/oauth/${SLUG}/callback`);
    url.searchParams.set('error', 'invalid_scope');
    url.searchParams.set('error_description', errorDescription);
    url.searchParams.set('state', state);
    const req = new Request(url.toString(), {
      method: 'GET',
      headers: { cookie: `nodalai_oauth_state=${cookieValue}` },
    });

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('oauth_error=invalid_scope');
    // Parse the redirect query so URLSearchParams handles +/encoding correctly.
    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get('detail')).toBe(errorDescription);
  });
});
