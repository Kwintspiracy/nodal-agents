// @vitest-environment node
// credentials.test.ts — unit + integration tests for credentials.ts
//
// Covers:
//   - encrypt at rest: raw row payload starts with enc:v1:
//   - getDecryptedCredential roundtrip
//   - persistCredentialFromOauthFlow inserts a new row
//   - refreshCredentialAccessToken mocks fetch + asserts payload updated in DB
//   - listCredentialsAction ownership filter (only own credentials returned)
//
// Uses pglite (in-memory) + spinUpTestDb for a real DB.
// Must run in 'node' environment (not jsdom) because pglite uses native Node APIs.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests, isEncrypted } from '@nodal-agents/secrets';
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
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/server.ts', () => ({
  getDb: () => {
    if (!_testDb) throw new Error('Test DB not initialized — call spinUpTestDb in beforeAll');
    return _testDb;
  },
  getAuthProvider: vi.fn(),
  requireAuth: vi.fn(),
  requireAuthWithEntity: vi.fn(),
  requireUser: vi.fn(),
  requireUserWithEntity: vi.fn(),
}));

// Mock requireAuth from @nodal-agents/auth so server actions resolve to our test user.
vi.mock('@nodal-agents/auth', () => ({
  requireAuth: vi.fn().mockImplementation(async () => ({
    userId: _testUserId,
    entityId: _testEntityId,
  })),
  LocalTrustProvider: class {
    getSession() {
      return Promise.resolve({ userId: _testUserId, entityId: _testEntityId });
    }
  },
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SAMPLE_PAYLOAD = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  refreshToken: 'test-refresh-token',
  accessToken: 'test-access-token',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scopes: 'https://www.googleapis.com/auth/drive openid email',
  accountName: 'test@example.com',
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

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

// ─── persistCredentialFromOauthFlow ──────────────────────────────────────────

describe('persistCredentialFromOauthFlow', () => {
  it('inserts a credential row with encrypted payload (enc:v1: prefix)', async () => {
    const { persistCredentialFromOauthFlow } = await import('../credentials.ts');

    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'My Google Credential',
      payload: SAMPLE_PAYLOAD,
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    // Raw SELECT — assert ciphertext prefix on payload column.
    const rows = await _testDb!.select().from(credentials).where(eq(credentials.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.payload).toMatch(/^enc:v1:/);
    expect(isEncrypted(row.payload)).toBe(true);

    // Plaintext metadata persisted correctly.
    expect(row.name).toBe('My Google Credential');
    expect(row.type).toBe('google-oauth');
    expect(row.ownerUserId).toBe(_testUserId);
  });

  it('always INSERTs — a second call creates a second row (no upsert)', async () => {
    const { persistCredentialFromOauthFlow } = await import('../credentials.ts');

    const r1 = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'notion-oauth',
      name: 'Notion Cred 1',
      payload: { ...SAMPLE_PAYLOAD, accountName: 'notion1@example.com' },
    });

    const r2 = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'notion-oauth',
      name: 'Notion Cred 2',
      payload: { ...SAMPLE_PAYLOAD, accountName: 'notion2@example.com' },
    });

    // Different IDs = two separate rows.
    expect(r1.id).not.toBe(r2.id);
  });
});

// ─── getDecryptedCredential ───────────────────────────────────────────────────

describe('getDecryptedCredential', () => {
  it('returns plaintext payload after persist roundtrip', async () => {
    const { persistCredentialFromOauthFlow, getDecryptedCredential } =
      await import('../credentials.ts');

    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'Roundtrip Test Cred',
      payload: SAMPLE_PAYLOAD,
    });

    const decrypted = await getDecryptedCredential(id);

    expect(decrypted).not.toBeNull();
    expect(decrypted!.id).toBe(id);
    expect(decrypted!.type).toBe('google-oauth');
    expect(decrypted!.ownerUserId).toBe(_testUserId);

    // All payload fields returned in plaintext.
    expect(decrypted!.payload.clientId).toBe('test-client-id');
    expect(decrypted!.payload.clientSecret).toBe('test-client-secret');
    expect(decrypted!.payload.refreshToken).toBe('test-refresh-token');
    expect(decrypted!.payload.accessToken).toBe('test-access-token');
    expect(decrypted!.payload.accountName).toBe('test@example.com');
  });

  it('returns null when credential id does not exist', async () => {
    const { getDecryptedCredential } = await import('../credentials.ts');

    const result = await getDecryptedCredential('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('auto-refreshes the access token when expiry is past and provider supports refresh', async () => {
    const { persistCredentialFromOauthFlow, getDecryptedCredential } =
      await import('../credentials.ts');

    // Persist a google credential whose access token expired 10 minutes ago.
    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'Expired Auto-Refresh Test',
      payload: {
        ...SAMPLE_PAYLOAD,
        accessToken: 'expired-token',
        refreshToken: 'still-valid-refresh',
        expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'auto-refreshed-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const decrypted = await getDecryptedCredential(id);

    vi.unstubAllGlobals();

    // The returned payload should already carry the freshly-minted token.
    expect(decrypted?.payload.accessToken).toBe('auto-refreshed-token');
    // Fetch should have been called exactly once (the refresh).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-refresh when the access token is still valid (>60s remaining)', async () => {
    const { persistCredentialFromOauthFlow, getDecryptedCredential } =
      await import('../credentials.ts');

    // Token valid for 1 hour.
    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'Still-Valid No-Refresh Test',
      payload: {
        ...SAMPLE_PAYLOAD,
        accessToken: 'still-fresh-token',
        refreshToken: 'unused-refresh-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const decrypted = await getDecryptedCredential(id);

    vi.unstubAllGlobals();

    expect(decrypted?.payload.accessToken).toBe('still-fresh-token');
    // No refresh attempted — fetch must not be called.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the stale payload (does not throw) when auto-refresh fails', async () => {
    const { persistCredentialFromOauthFlow, getDecryptedCredential } =
      await import('../credentials.ts');

    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'Auto-Refresh Failure Test',
      payload: {
        ...SAMPLE_PAYLOAD,
        accessToken: 'stale-token-stays',
        refreshToken: 'broken-refresh-token',
        expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const decrypted = await getDecryptedCredential(id);

    vi.unstubAllGlobals();
    consoleSpy.mockRestore();

    // Caller still gets the credential (no throw, no null) — caller's API call
    // will likely 401 and surface the re-auth need.
    expect(decrypted).not.toBeNull();
    expect(decrypted?.payload.accessToken).toBe('stale-token-stays');
  });
});

// ─── listCredentialsAction — ownership filter ─────────────────────────────────

describe('listCredentialsAction — ownership filter', () => {
  it('only returns credentials owned by the current user (not other users)', async () => {
    const { persistCredentialFromOauthFlow, listCredentialsAction } =
      await import('../credentials.ts');

    // Create a credential for our test user.
    await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'airtable-oauth',
      name: 'My Airtable Cred (list test)',
      payload: { ...SAMPLE_PAYLOAD, accountName: 'me@example.com' },
    });

    // Insert a credential for a different user_id directly via pglite raw SQL
    // (bypassing FK checks — we only want to verify the WHERE clause).
    const otherUserId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await _testDb!.execute(`
      INSERT INTO users (id, email) VALUES ('${otherUserId}', 'other-${Date.now()}@example.com')
      ON CONFLICT (id) DO NOTHING
    `);
    await _testDb!.execute(`
      INSERT INTO credentials (id, owner_user_id, name, type, payload)
      VALUES (gen_random_uuid(), '${otherUserId}', 'Other User Cred', 'google-oauth', 'enc:v1:fakepayload')
    `);

    const result = await listCredentialsAction();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No credential from the other user should appear.
    for (const item of result.data) {
      expect(item.name).not.toBe('Other User Cred');
    }
    // At least one of our own credentials appears.
    const found = result.data.some((i) => i.name === 'My Airtable Cred (list test)');
    expect(found).toBe(true);
  });

  it('filterType narrows results to that credential type', async () => {
    const { listCredentialsAction } = await import('../credentials.ts');

    const result = await listCredentialsAction('airtable-oauth');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const item of result.data) {
      expect(item.type).toBe('airtable-oauth');
    }
  });
});

// ─── refreshCredentialAccessToken ────────────────────────────────────────────

describe('refreshCredentialAccessToken', () => {
  it('updates encrypted payload in DB and returns new plaintext accessToken', async () => {
    const { persistCredentialFromOauthFlow, refreshCredentialAccessToken, getDecryptedCredential } =
      await import('../credentials.ts');

    // Persist a google credential with a refresh token.
    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'Refresh Test Cred',
      payload: {
        ...SAMPLE_PAYLOAD,
        accessToken: 'old-access-token',
        refreshToken: 'valid-refresh-token',
      },
    });

    // Capture old ciphertext.
    const beforeRows = await _testDb!.select().from(credentials).where(eq(credentials.id, id));
    const oldCipher = beforeRows[0]!.payload;

    // Mock fetch to return a new access token.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'brand-new-access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshCredentialAccessToken(id);

    vi.unstubAllGlobals();

    // Return value: plaintext new access token.
    expect(result.accessToken).toBe('brand-new-access-token');
    expect(result.expiresAt).not.toBeNull();

    // DB: payload updated (new ciphertext, different from old).
    const afterRows = await _testDb!.select().from(credentials).where(eq(credentials.id, id));
    const newCipher = afterRows[0]!.payload;
    expect(newCipher).toMatch(/^enc:v1:/);
    expect(newCipher).not.toBe(oldCipher);

    // Decrypt + assert new access token stored.
    const decrypted = await getDecryptedCredential(id);
    expect(decrypted?.payload.accessToken).toBe('brand-new-access-token');
  });

  it('stores the rotated refresh_token when provider returns one (RFC 6749 §10.4)', async () => {
    const { persistCredentialFromOauthFlow, refreshCredentialAccessToken, getDecryptedCredential } =
      await import('../credentials.ts');

    // Simulate Airtable / GitHub-style refresh-token rotation: the provider
    // returns a NEW refresh_token in the response and invalidates the previous one.
    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'airtable-oauth',
      name: 'Rotation Test Cred',
      payload: {
        ...SAMPLE_PAYLOAD,
        refreshToken: 'refresh-v1',
        accessToken: 'access-v1',
      },
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'access-v2',
          refresh_token: 'refresh-v2-rotated',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await refreshCredentialAccessToken(id);

    vi.unstubAllGlobals();

    // The new refresh_token must be persisted, otherwise the next refresh call
    // would fail with invalid_grant against rotation-enforcing providers.
    const decrypted = await getDecryptedCredential(id);
    expect(decrypted?.payload.refreshToken).toBe('refresh-v2-rotated');
    expect(decrypted?.payload.accessToken).toBe('access-v2');
  });

  it('keeps the existing refresh_token when provider does NOT rotate it', async () => {
    const { persistCredentialFromOauthFlow, refreshCredentialAccessToken, getDecryptedCredential } =
      await import('../credentials.ts');

    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'No-Rotation Test Cred',
      payload: {
        ...SAMPLE_PAYLOAD,
        refreshToken: 'sticky-refresh-token',
      },
    });

    // Token endpoint response WITHOUT a refresh_token field — Google's default behaviour.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'new-access-only', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await refreshCredentialAccessToken(id);

    vi.unstubAllGlobals();

    const decrypted = await getDecryptedCredential(id);
    expect(decrypted?.payload.refreshToken).toBe('sticky-refresh-token');
    expect(decrypted?.payload.accessToken).toBe('new-access-only');
  });

  it('throws when credential does not support refresh (Notion)', async () => {
    const { persistCredentialFromOauthFlow, refreshCredentialAccessToken } =
      await import('../credentials.ts');

    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'notion-oauth',
      name: 'Notion No-Refresh',
      payload: { ...SAMPLE_PAYLOAD, refreshToken: null },
    });

    await expect(refreshCredentialAccessToken(id)).rejects.toThrow(
      'does not support token refresh',
    );
  });

  it('throws when token endpoint returns 4xx', async () => {
    const { persistCredentialFromOauthFlow, refreshCredentialAccessToken } =
      await import('../credentials.ts');

    const { id } = await persistCredentialFromOauthFlow({
      ownerUserId: _testUserId,
      credentialType: 'google-oauth',
      name: 'Refresh 4xx Test',
      payload: { ...SAMPLE_PAYLOAD, refreshToken: 'stale-refresh-token' },
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshCredentialAccessToken(id)).rejects.toThrow('token endpoint returned 400');

    vi.unstubAllGlobals();
  });

  it('throws when credential id does not exist', async () => {
    const { refreshCredentialAccessToken } = await import('../credentials.ts');

    await expect(
      refreshCredentialAccessToken('99999999-9999-9999-9999-999999999999'),
    ).rejects.toThrow("credential '99999999-9999-9999-9999-999999999999' not found");
  });
});
