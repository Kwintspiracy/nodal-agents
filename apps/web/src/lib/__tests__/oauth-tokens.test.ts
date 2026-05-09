// @vitest-environment node
// oauth-tokens.test.ts — integration tests for persistOauthTokens,
// getDecryptedConnector, and refreshOauthAccessToken.
//
// Uses pglite (in-memory) + the test helpers from @nodalai/db/test-utils.
// Must run in 'node' environment (not jsdom) because pglite uses native
// Node APIs (Blob.arrayBuffer, WASM) unavailable in jsdom.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests, isEncrypted } from '@nodalai/secrets';
import { spinUpTestDb, seedMinimal } from '@nodalai/db/test-utils';
import type { TestDb } from '@nodalai/db/test-utils';
import { connectors } from '@nodalai/db';
import { eq } from '@nodalai/db';

// ─── Module-level mock setup ──────────────────────────────────────────────────
// vi.mock is hoisted by Vitest, so the factory runs before any imports.
// We use a mutable holder that beforeAll populates with the real pglite db.

let _testDb: TestDb | null = null;

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mock server.ts so getDb() returns our pglite instance.
// Use the @/ alias path since that's what oauth-tokens.ts uses when resolved
// by Vite. The alias resolves to apps/web/src/, and oauth-tokens.ts uses
// the relative path './server.ts' which Vitest normalizes to @/lib/server.ts
// internally. We mock both to be safe.
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

// ─── Test fixtures ────────────────────────────────────────────────────────────

let entityId: string;

beforeAll(async () => {
  // Inject deterministic master key so encrypt/decrypt never hits the real key file.
  _setMasterKeyForTests(randomBytes(32));

  // Boot pglite and assign to the holder used by the mock above.
  const { db } = await spinUpTestDb();
  _testDb = db;

  // Seed minimal rows (user + entity).
  const seed = await seedMinimal(db);
  entityId = seed.entityId;
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
  _testDb = null;
  vi.restoreAllMocks();
});

// ─── persistOauthTokens ───────────────────────────────────────────────────────

describe('persistOauthTokens', () => {
  it('inserts a connector row with encrypted sensitive fields', async () => {
    const { persistOauthTokens } = await import('../oauth-tokens.ts');

    await persistOauthTokens({
      entityId,
      slug: 'google-drive',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token',
      accessToken: 'test-access-token',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: 'https://www.googleapis.com/auth/drive openid email',
      accountName: 'test@example.com',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    // Raw SELECT — assert ciphertext prefix on sensitive columns.
    const rows = await _testDb!.select().from(connectors).where(eq(connectors.entityId, entityId));

    const row = rows.find((r) => r.slug === 'google-drive');
    expect(row).toBeDefined();

    // Sensitive fields must be encrypted at rest.
    expect(row!.oauthClientSecret).not.toBeNull();
    expect(isEncrypted(row!.oauthClientSecret!)).toBe(true);
    expect(row!.oauthClientSecret).toMatch(/^enc:v1:/);

    expect(row!.oauthRefreshToken).not.toBeNull();
    expect(isEncrypted(row!.oauthRefreshToken!)).toBe(true);
    expect(row!.oauthRefreshToken).toMatch(/^enc:v1:/);

    expect(row!.oauthAccessToken).not.toBeNull();
    expect(isEncrypted(row!.oauthAccessToken!)).toBe(true);
    expect(row!.oauthAccessToken).toMatch(/^enc:v1:/);

    // Non-secret fields stored in plaintext.
    expect(row!.oauthClientId).toBe('test-client-id');
    expect(row!.oauthAccountName).toBe('test@example.com');
    expect(row!.oauthScopes).toBe('https://www.googleapis.com/auth/drive openid email');
  });

  it('returns the id of the created row', async () => {
    const { persistOauthTokens } = await import('../oauth-tokens.ts');

    const result = await persistOauthTokens({
      entityId,
      slug: 'gmail',
      clientId: 'gmail-client-id',
      clientSecret: 'gmail-secret',
      refreshToken: 'gmail-refresh',
      accessToken: 'gmail-access',
      expiresAt: null,
      scopes: 'https://www.googleapis.com/auth/gmail.readonly',
      accountName: null,
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('idempotent: second call with same (entityId, slug) updates, not inserts', async () => {
    const { persistOauthTokens } = await import('../oauth-tokens.ts');

    const r1 = await persistOauthTokens({
      entityId,
      slug: 'google-sheets',
      clientId: 'sheets-client-id',
      clientSecret: 'sheets-secret-1',
      refreshToken: 'sheets-refresh-1',
      accessToken: 'sheets-access-1',
      expiresAt: null,
      scopes: null,
      accountName: null,
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    const r2 = await persistOauthTokens({
      entityId,
      slug: 'google-sheets',
      clientId: 'sheets-client-id',
      clientSecret: 'sheets-secret-2', // changed
      refreshToken: 'sheets-refresh-2', // changed
      accessToken: 'sheets-access-2', // changed
      expiresAt: null,
      scopes: null,
      accountName: 'updated@example.com',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    // Must return the SAME id (update, not insert).
    expect(r1.id).toBe(r2.id);

    // And only one row with this slug in the DB.
    const rows = await _testDb!.select().from(connectors).where(eq(connectors.entityId, entityId));
    const sheetsRows = rows.filter((r) => r.slug === 'google-sheets');
    expect(sheetsRows).toHaveLength(1);

    // The second persist should have updated the account name.
    expect(sheetsRows[0]!.oauthAccountName).toBe('updated@example.com');
  });

  it('throws for unknown connector slug', async () => {
    const { persistOauthTokens } = await import('../oauth-tokens.ts');

    await expect(
      persistOauthTokens({
        entityId,
        slug: 'nonexistent-slug',
        clientId: 'x',
        clientSecret: 'x',
        refreshToken: null,
        accessToken: 'x',
        expiresAt: null,
        scopes: null,
        accountName: null,
        tokenUrl: 'https://example.com',
      }),
    ).rejects.toThrow("unknown connector slug 'nonexistent-slug'");
  });
});

// ─── getDecryptedConnector ────────────────────────────────────────────────────

describe('getDecryptedConnector', () => {
  it('returns plaintext values for all sensitive fields after persist', async () => {
    const { persistOauthTokens, getDecryptedConnector } = await import('../oauth-tokens.ts');

    const { id } = await persistOauthTokens({
      entityId,
      slug: 'google-docs',
      clientId: 'docs-client-id',
      clientSecret: 'docs-client-secret',
      refreshToken: 'docs-refresh-token',
      accessToken: 'docs-access-token',
      expiresAt: null,
      scopes: 'https://www.googleapis.com/auth/documents',
      accountName: 'docs@example.com',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    const decrypted = await getDecryptedConnector(id);

    expect(decrypted.id).toBe(id);
    expect(decrypted.slug).toBe('google-docs');
    expect(decrypted.clientId).toBe('docs-client-id');
    expect(decrypted.clientSecret).toBe('docs-client-secret');
    expect(decrypted.refreshToken).toBe('docs-refresh-token');
    expect(decrypted.accessToken).toBe('docs-access-token');
    expect(decrypted.scopes).toBe('https://www.googleapis.com/auth/documents');
    expect(decrypted.accountName).toBe('docs@example.com');
  });

  it('returns legacy plaintext accessToken as-is (no enc:v1: prefix)', async () => {
    // Insert a row with plaintext (legacy) oauth_access_token directly.
    const [legacyRow] = await _testDb!
      .insert(connectors)
      .values({
        entityId,
        slug: 'notion-oauth',
        name: 'Notion (OAuth) legacy',
        authType: 'oauth2',
        active: true,
        oauthClientId: 'notion-client-id',
        oauthClientSecret: null,
        oauthRefreshToken: null,
        oauthAccessToken: 'legacy_plaintext_access_token', // no enc:v1: prefix
        oauthTokenExpiresAt: null,
        oauthTokenUrl: 'https://api.notion.com/v1/oauth/token',
        oauthScopes: null,
        oauthAccountName: 'workspace-name',
      })
      .returning({ id: connectors.id });

    if (!legacyRow) throw new Error('Failed to insert legacy row');

    const { getDecryptedConnector } = await import('../oauth-tokens.ts');
    const decrypted = await getDecryptedConnector(legacyRow.id);

    // Should return the plaintext value as-is, without throwing.
    expect(decrypted.accessToken).toBe('legacy_plaintext_access_token');
  });

  it('throws when connector id does not exist', async () => {
    const { getDecryptedConnector } = await import('../oauth-tokens.ts');

    await expect(getDecryptedConnector('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      "connector '00000000-0000-0000-0000-000000000000' not found",
    );
  });
});

// ─── refreshOauthAccessToken ──────────────────────────────────────────────────

describe('refreshOauthAccessToken', () => {
  it('updates encrypted accessToken in DB and returns plaintext', async () => {
    const { persistOauthTokens, refreshOauthAccessToken, getDecryptedConnector } =
      await import('../oauth-tokens.ts');

    // Persist gmail with a refresh token so we can call refreshOauthAccessToken.
    const { id: connectorId } = await persistOauthTokens({
      entityId,
      slug: 'gmail',
      clientId: 'gmail-client-id',
      clientSecret: 'gmail-secret',
      refreshToken: 'gmail-refresh',
      accessToken: 'gmail-old-access',
      expiresAt: null,
      scopes: 'https://www.googleapis.com/auth/gmail.readonly',
      accountName: null,
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    // Capture the old ciphertext.
    const beforeRows = await _testDb!
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    const oldCipher = beforeRows[0]!.oauthAccessToken;

    // Mock fetch to return a new access token.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'new-access-token-xyz', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshOauthAccessToken(connectorId);

    vi.unstubAllGlobals();

    // Return value must be plaintext new access token.
    expect(result.accessToken).toBe('new-access-token-xyz');
    expect(result.expiresAt).not.toBeNull();

    // The expiry should be ~now + 3600s (within 5s tolerance).
    const nowPlusHour = Date.now() + 3600_000;
    expect(Math.abs(result.expiresAt!.getTime() - nowPlusHour)).toBeLessThan(5000);

    // DB must now have a NEW ciphertext (enc:v1: prefix, different from before).
    const afterRows = await _testDb!
      .select()
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    const newCipher = afterRows[0]!.oauthAccessToken;
    expect(newCipher).toMatch(/^enc:v1:/);
    // The new ciphertext is different from the old one (different IV + plaintext).
    expect(newCipher).not.toBe(oldCipher);

    // Decrypted value must equal the plaintext returned.
    const decrypted = await getDecryptedConnector(connectorId);
    expect(decrypted.accessToken).toBe('new-access-token-xyz');
  });

  it('throws oauth_no_refresh message for Notion (supportsRefresh: false)', async () => {
    // notion-oauth was inserted as a legacy row in getDecryptedConnector tests.
    const rows = await _testDb!.select().from(connectors).where(eq(connectors.entityId, entityId));
    const notionRow = rows.find((r) => r.slug === 'notion-oauth');
    expect(notionRow).toBeDefined();

    const { refreshOauthAccessToken } = await import('../oauth-tokens.ts');

    await expect(refreshOauthAccessToken(notionRow!.id)).rejects.toThrow(
      'does not support token refresh',
    );
  });

  it('throws when connector not found', async () => {
    const { refreshOauthAccessToken } = await import('../oauth-tokens.ts');

    await expect(refreshOauthAccessToken('99999999-9999-9999-9999-999999999999')).rejects.toThrow(
      "connector '99999999-9999-9999-9999-999999999999' not found",
    );
  });

  it('throws when token endpoint returns 4xx', async () => {
    const { persistOauthTokens, refreshOauthAccessToken } = await import('../oauth-tokens.ts');

    const { id } = await persistOauthTokens({
      entityId,
      slug: 'google-sheets',
      clientId: 'sheets-client-id',
      clientSecret: 'sheets-secret',
      refreshToken: 'sheets-refresh',
      accessToken: 'sheets-access',
      expiresAt: null,
      scopes: null,
      accountName: null,
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshOauthAccessToken(id)).rejects.toThrow('token endpoint returned 400');

    vi.unstubAllGlobals();
  });
});
