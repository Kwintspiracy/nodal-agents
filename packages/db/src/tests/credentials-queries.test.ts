// credentials-queries.test.ts
// Unit tests for packages/db/src/queries/credentials.ts
// Uses pglite (spinUpTestDb) so no external DB is needed.
//
// Coverage:
//  - roundtrip: encrypt payload, store, fetch → payload decrypted back
//  - null for unknown id
//  - auto-refresh on expiring token (mocked fetch)
//  - rotation preservation (new refresh_token in response is persisted)
//  - stale-on-refresh-fail (non-fatal: original payload returned)

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { _setMasterKeyForTests, _resetMasterKeyCacheForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import { credentials } from '../schema/index.ts';
import {
  getDecryptedCredentialById,
  decryptCredentialForDisplay,
  refreshAndPersistCredential,
} from '../queries/credentials.ts';

// ─── Deterministic test key ───────────────────────────────────────────────────
const TEST_KEY = randomBytes(32);

beforeAll(() => {
  _setMasterKeyForTests(TEST_KEY);
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGooglePayload(overrides: Record<string, unknown> = {}): string {
  const payload = {
    accessToken: 'access-token-abc',
    refreshToken: 'refresh-token-xyz',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1h from now
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    scope: 'https://www.googleapis.com/auth/drive',
    ...overrides,
  };
  return encrypt(JSON.stringify(payload));
}

async function insertCredential(
  db: TestDb,
  userId: string,
  payloadOverrides: Record<string, unknown> = {},
) {
  const [row] = await db
    .insert(credentials)
    .values({
      ownerUserId: userId,
      name: `test-cred-${Date.now()}`,
      type: 'google-oauth',
      payload: makeGooglePayload(payloadOverrides),
    })
    .returning();
  if (!row) throw new Error('Failed to insert credential');
  return row;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let db: TestDb;
let userId: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const seed = await seedMinimal(db);
  userId = seed.userId;
});

describe('getDecryptedCredentialById', () => {
  it('returns null for unknown id', async () => {
    const result = await getDecryptedCredentialById(db, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('roundtrip: encrypted payload is decrypted on fetch', async () => {
    const row = await insertCredential(db, userId);
    const result = await getDecryptedCredentialById(db, row.id);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(row.id);
    expect(result!.ownerUserId).toBe(userId);
    expect(result!.type).toBe('google-oauth');
    expect(result!.payload.accessToken).toBe('access-token-abc');
    expect(result!.payload.refreshToken).toBe('refresh-token-xyz');
  });

  it('returns the credential without refresh when token is far from expiry', async () => {
    const row = await insertCredential(db, userId, {
      expiresAt: new Date(Date.now() + 10 * 3600 * 1000).toISOString(), // 10h
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await getDecryptedCredentialById(db, row.id);

    expect(result!.payload.accessToken).toBe('access-token-abc');
    // fetch should NOT have been called (token not expiring soon)
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('auto-refresh: triggers refresh when token expires within 60s', async () => {
    // Token expires in 30 seconds — within the 60s refresh buffer
    const soonExpiry = new Date(Date.now() + 30 * 1000).toISOString();
    const row = await insertCredential(db, userId, { expiresAt: soonExpiry });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'refreshed-access-token',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await getDecryptedCredentialById(db, row.id);

    // fetch must have been called for the token endpoint
    expect(fetchMock).toHaveBeenCalledOnce();
    // Result has the NEW access token
    expect(result!.payload.accessToken).toBe('refreshed-access-token');
    // DB is updated — re-fetch raw row to confirm encrypted payload changed
    const [updated] = await db.select().from(credentials).where(eq(credentials.id, row.id));
    // We can't compare raw ciphertext equality (non-deterministic), but decrypting
    // the updated row must yield the new access token.
    const { decrypt } = await import('@nodal-agents/secrets');
    const updatedPayload = JSON.parse(decrypt(updated!.payload)) as Record<string, unknown>;
    expect(updatedPayload['accessToken']).toBe('refreshed-access-token');

    fetchMock.mockRestore();
  });

  it('rotation preservation: rotated refresh_token is persisted to DB', async () => {
    const soonExpiry = new Date(Date.now() + 30 * 1000).toISOString();
    const row = await insertCredential(db, userId, {
      expiresAt: soonExpiry,
      refreshToken: 'original-refresh-token',
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          expires_in: 3600,
          refresh_token: 'new-rotated-refresh',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await getDecryptedCredentialById(db, row.id);

    const [updated] = await db.select().from(credentials).where(eq(credentials.id, row.id));
    const { decrypt } = await import('@nodal-agents/secrets');
    const updatedPayload = JSON.parse(decrypt(updated!.payload)) as Record<string, unknown>;
    expect(updatedPayload['refreshToken']).toBe('new-rotated-refresh');

    fetchMock.mockRestore();
  });

  it('stale-on-fail: returns stale payload when refresh fails (non-fatal)', async () => {
    const soonExpiry = new Date(Date.now() + 30 * 1000).toISOString();
    const row = await insertCredential(db, userId, {
      expiresAt: soonExpiry,
      accessToken: 'stale-access-token',
    });

    // Make fetch fail
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    const result = await getDecryptedCredentialById(db, row.id);

    // Must still return a result (non-fatal fallback)
    expect(result).not.toBeNull();
    // The stale access token is returned (refresh failed, fall through)
    expect(result!.payload.accessToken).toBe('stale-access-token');

    fetchMock.mockRestore();
  });
});

describe('decryptCredentialForDisplay', () => {
  it('returns null for unknown id', async () => {
    const result = await decryptCredentialForDisplay(db, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('does NOT trigger a refresh even when token is expiring soon', async () => {
    // Token expires in 30 seconds — would trip the auto-refresh in
    // getDecryptedCredentialById, but the display-only helper must skip it.
    const soonExpiry = new Date(Date.now() + 30 * 1000).toISOString();
    const row = await insertCredential(db, userId, {
      expiresAt: soonExpiry,
      accessToken: 'still-stale-on-display',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await decryptCredentialForDisplay(db, row.id);

    expect(result).not.toBeNull();
    expect(result!.payload.accessToken).toBe('still-stale-on-display');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('refreshAndPersistCredential', () => {
  it('throws when credential not found', async () => {
    await expect(
      refreshAndPersistCredential(db, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('not found');
  });

  it('returns new access token and updates DB', async () => {
    const row = await insertCredential(db, userId);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { accessToken, expiresAt } = await refreshAndPersistCredential(db, row.id);

    expect(accessToken).toBe('fresh-token');
    expect(expiresAt).toBeInstanceOf(Date);

    fetchMock.mockRestore();
  });
});
