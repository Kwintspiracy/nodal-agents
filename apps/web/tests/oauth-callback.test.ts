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
import { credentials, decryptCredentialForDisplay } from '@nodal-agents/db';
import { getOAuthProvider } from '@nodal-agents/shared';
// Static: runner-adapters pulls every adapter; loaded at collection, not
// inside a test's timeout.
import { connectorAccessFor } from '@nodal-agents/runner-adapters';
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
  connector?: string;
  requestedScopes?: string;
  credentialId?: string;
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
    connector: opts.connector ?? 'google-drive',
    requestedScopes: opts.requestedScopes ?? 'https://www.googleapis.com/auth/drive openid email',
    ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
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
    /** The grant the provider answers with; `null` omits the field. */
    scope?: string | null;
  } = {},
): ReturnType<typeof vi.fn> {
  const {
    access_token = 'test-access-token',
    refresh_token = 'test-refresh-token',
    expires_in = 3600,
    email = 'test@example.com',
    scope = 'https://www.googleapis.com/auth/drive openid email',
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
            ...(scope === null ? {} : { scope }),
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
// The path names the credential type: the OAuth client the person registered.
const SLUG = 'google-oauth';

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

describe('GET /api/oauth/[provider]/callback — I-8 open-redirect guard on returnTo', () => {
  it('an external https:// returnTo is ignored — falls back to /credentials?created=..., never redirects off-origin', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
      returnTo: 'https://evil.example/steal',
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_OPEN_REDIRECT',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({ email: 'redirect-guard@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).not.toContain('evil.example');
    expect(location.startsWith(`${ORIGIN}/credentials?created=`)).toBe(true);
  });

  it('a protocol-relative //evil.example returnTo is ignored', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
      returnTo: '//evil.example/steal',
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_PROTOCOL_RELATIVE',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({ email: 'protocol-relative@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).not.toContain('evil.example');
    expect(location.startsWith(`${ORIGIN}/credentials?created=`)).toBe(true);
  });

  it('a legitimate internal returnTo with query params still works and gets credentialId appended', async () => {
    const { cookieValue, state } = await buildValidCookie({
      slug: SLUG,
      entityId: _testEntityId,
      returnTo: '/connectors?connectorSlug=google-drive',
    });
    const req = buildCallbackRequest({
      origin: ORIGIN,
      slug: SLUG,
      code: 'AUTH_CODE_INTERNAL_RETURNTO',
      state,
      cookieValue,
    });

    const fetchMock = mockSuccessfulGoogleFetch({ email: 'internal-returnto@example.com' });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

    vi.unstubAllGlobals();

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('connectorSlug=google-drive');
    expect(location).toContain('credentialId=');
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

  it('I-9 (audit #2): a "mock-" code is NOT bypassed outside test/e2e (NODE_ENV=production, no opt-in flag)', async () => {
    const originalNodeEnv = process.env['NODE_ENV'];
    const originalFlag = process.env['NODALAI_ALLOW_OAUTH_MOCK'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['NODALAI_ALLOW_OAUTH_MOCK'];

    try {
      const { cookieValue, state } = await buildValidCookie({
        slug: SLUG,
        entityId: _testEntityId,
      });
      const req = buildCallbackRequest({
        origin: ORIGIN,
        slug: SLUG,
        code: 'mock-should-not-bypass',
        state,
        cookieValue,
      });

      // No mock covers the real token endpoint — if the bypass fired it would
      // never call fetch at all and redirect straight to a created credential.
      const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
      vi.stubGlobal('fetch', fetchMock);

      const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
      const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

      vi.unstubAllGlobals();

      // The real token exchange was attempted (and failed, since it 401s).
      expect(fetchMock).toHaveBeenCalled();
      expect(response.status).toBe(302);
      const location = response.headers.get('location') ?? '';
      expect(location).toContain('oauth_error=token_exchange_failed');
    } finally {
      process.env['NODE_ENV'] = originalNodeEnv;
      if (originalFlag === undefined) delete process.env['NODALAI_ALLOW_OAUTH_MOCK'];
      else process.env['NODALAI_ALLOW_OAUTH_MOCK'] = originalFlag;
    }
  });

  it('I-9 (audit #2): a "mock-" code IS bypassed when NODALAI_ALLOW_OAUTH_MOCK=1 is explicitly set', async () => {
    const originalNodeEnv = process.env['NODE_ENV'];
    const originalFlag = process.env['NODALAI_ALLOW_OAUTH_MOCK'];
    process.env['NODE_ENV'] = 'production';
    process.env['NODALAI_ALLOW_OAUTH_MOCK'] = '1';

    try {
      const { cookieValue, state } = await buildValidCookie({
        slug: SLUG,
        entityId: _testEntityId,
      });
      const req = buildCallbackRequest({
        origin: ORIGIN,
        slug: SLUG,
        code: 'mock-explicit-optin',
        state,
        cookieValue,
      });

      // accountInfo (userinfo) is still fetched after the bypass mints tokens —
      // only the TOKEN endpoint call is skipped.
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ email: 'bypass@example.com', name: 'Bypass User' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
      const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });

      vi.unstubAllGlobals();

      // Every fetch call made was the accountInfo lookup, never the token endpoint.
      for (const call of fetchMock.mock.calls) {
        expect(String(call[0])).not.toContain('token');
      }
      expect(response.status).toBe(302);
      const location = response.headers.get('location') ?? '';
      expect(location).toContain('/credentials?created=');
    } finally {
      process.env['NODE_ENV'] = originalNodeEnv;
      if (originalFlag === undefined) delete process.env['NODALAI_ALLOW_OAUTH_MOCK'];
      else process.env['NODALAI_ALLOW_OAUTH_MOCK'] = originalFlag;
    }
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

// ─── The grant the provider answered with is what the credential holds ───────

const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const DRIVE = 'https://www.googleapis.com/auth/drive';

async function runCallback(opts: {
  cookie: Parameters<typeof buildValidCookie>[0];
  code: string;
  fetchMock: ReturnType<typeof vi.fn>;
}): Promise<string> {
  const { cookieValue, state } = await buildValidCookie(opts.cookie);
  const req = buildCallbackRequest({
    origin: ORIGIN,
    slug: SLUG,
    code: opts.code,
    state,
    cookieValue,
  });
  vi.stubGlobal('fetch', opts.fetchMock);
  try {
    const { GET } = await import('@/app/api/oauth/[provider]/callback/route.ts');
    const response = await GET(req, { params: Promise.resolve({ provider: SLUG }) });
    expect(response.status).toBe(302);
    return response.headers.get('location') ?? '';
  } finally {
    vi.unstubAllGlobals();
  }
}

async function storedScopes(credentialId: string): Promise<string> {
  const cred = await decryptCredentialForDisplay(_testDb!, credentialId);
  return cred!.payload.scopes;
}

describe('GET /api/oauth/[provider]/callback — the granted scopes are stored @cap:connecter-un-service/moteur', () => {
  it('stores what the provider granted when it grants less than asked, and the connector then lacks exactly that', async () => {
    // Asked: every Gmail right. Granted: read only (the person unticked the rest).
    const location = await runCallback({
      cookie: {
        slug: SLUG,
        entityId: _testEntityId,
        connector: 'gmail',
        requestedScopes: getOAuthProvider('gmail')!.scopes.join(' '),
      },
      code: 'AUTH_CODE_PARTIAL',
      fetchMock: mockSuccessfulGoogleFetch({
        email: 'partial@example.com',
        scope: `${GMAIL_READONLY} openid https://www.googleapis.com/auth/userinfo.email`,
      }),
    });
    const credentialId = new URL(location).searchParams.get('created')!;
    const scopes = await storedScopes(credentialId);
    expect(scopes).toBe(`${GMAIL_READONLY} openid https://www.googleapis.com/auth/userinfo.email`);

    const access = connectorAccessFor('gmail', scopes);
    expect(access.kind).toBe('needs_access');
    if (access.kind !== 'needs_access') throw new Error('unreachable');
    expect(access.grantedOperations).toContain('gmail_list_messages');
    expect(access.missingOperations).toContain('gmail_send_email');
    expect(access.missingScopes).toContain(GMAIL_SEND);
  });

  it('stores what was asked when the provider omits `scope` (RFC 6749 §5.1: identical grant)', async () => {
    const asked = `${DRIVE} openid`;
    const location = await runCallback({
      cookie: { slug: SLUG, entityId: _testEntityId, requestedScopes: asked },
      code: 'AUTH_CODE_NO_SCOPE',
      fetchMock: mockSuccessfulGoogleFetch({ email: 'noscope@example.com', scope: null }),
    });
    expect(await storedScopes(new URL(location).searchParams.get('created')!)).toBe(asked);
  });

  it('adding access updates the SAME credential with the new grant, and inserts no row', async () => {
    // An existing Drive-only credential for addaccess@example.com.
    const [existing] = await _testDb!
      .insert(credentials)
      .values({
        ownerUserId: _testUserId,
        name: 'Existing Google',
        type: 'google-oauth',
        payload: encrypt(
          JSON.stringify({
            clientId: 'stored-client-id',
            clientSecret: 'stored-client-secret',
            refreshToken: 'old-rt',
            accessToken: 'old-at',
            expiresAt: null,
            scopes: `${DRIVE} openid`,
            accountName: 'addaccess@example.com',
            tokenUrl: 'https://oauth2.googleapis.com/token',
          }),
        ),
      })
      .returning();
    const before = await _testDb!.select({ id: credentials.id }).from(credentials);

    const granted = `${DRIVE} ${GMAIL_READONLY} ${GMAIL_SEND} openid`;
    const location = await runCallback({
      cookie: {
        slug: SLUG,
        entityId: _testEntityId,
        connector: 'gmail',
        credentialId: existing!.id,
        requestedScopes: granted,
        returnTo: '/connectors?connectorSlug=gmail',
      },
      code: 'AUTH_CODE_ADD_ACCESS',
      fetchMock: mockSuccessfulGoogleFetch({
        email: 'addaccess@example.com',
        access_token: 'new-at',
        scope: granted,
      }),
    });

    expect(new URL(location, ORIGIN).searchParams.get('credentialId')).toBe(existing!.id);
    const after = await _testDb!.select({ id: credentials.id }).from(credentials);
    expect(after).toHaveLength(before.length);
    const updated = await decryptCredentialForDisplay(_testDb!, existing!.id);
    expect(updated!.payload.scopes).toBe(granted);
    expect(updated!.payload.accessToken).toBe('new-at');
    expect(updated!.name).toBe('Existing Google');
  });

  it('refuses to put another account on an existing credential, and leaves it untouched', async () => {
    const [existing] = await _testDb!
      .insert(credentials)
      .values({
        ownerUserId: _testUserId,
        name: 'Owner Google',
        type: 'google-oauth',
        payload: encrypt(
          JSON.stringify({
            clientId: 'c',
            clientSecret: 's',
            refreshToken: 'rt',
            accessToken: 'at-kept',
            expiresAt: null,
            scopes: DRIVE,
            accountName: 'first@example.com',
            tokenUrl: 'https://oauth2.googleapis.com/token',
          }),
        ),
      })
      .returning();

    const location = await runCallback({
      cookie: {
        slug: SLUG,
        entityId: _testEntityId,
        connector: 'gmail',
        credentialId: existing!.id,
        requestedScopes: `${DRIVE} ${GMAIL_READONLY}`,
      },
      code: 'AUTH_CODE_OTHER_ACCOUNT',
      fetchMock: mockSuccessfulGoogleFetch({ email: 'second@example.com' }),
    });

    expect(location).toContain('oauth_error=account_mismatch');
    const kept = await decryptCredentialForDisplay(_testDb!, existing!.id);
    expect(kept!.payload.accessToken).toBe('at-kept');
    expect(kept!.payload.scopes).toBe(DRIVE);
  });

  it('refuses a state cookie whose connector does not authorise through the path type', async () => {
    const location = await runCallback({
      cookie: { slug: SLUG, entityId: _testEntityId, connector: 'outlook-mail' },
      code: 'AUTH_CODE_WRONG_FAMILY',
      fetchMock: mockSuccessfulGoogleFetch(),
    });
    expect(location).toContain('oauth_error=unknown_provider');
  });
});
