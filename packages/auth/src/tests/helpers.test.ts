// Tests for requireAuth and requireAuthWithEntity helpers.

import { describe, it, expect, beforeAll } from 'vitest';
import { requireAuth, requireAuthWithEntity } from '../helpers.ts';
import { AuthError, NoEntityError } from '../types.ts';
import {
  LocalTrustProvider,
  seedLocalUser,
  LOCAL_USER_ID,
  LOCAL_ENTITY_ID,
} from '../providers/local-trust.ts';
import { BearerTokenProvider } from '../providers/bearer-token.ts';
import { spinUpAuthTestDb, fakeRequest } from './helpers.ts';
import type { AuthTestDb } from './helpers.ts';
import type { AuthProvider } from '../types.ts';

let db: AuthTestDb;

// A provider that always returns null (unauthenticated)
const nullProvider: AuthProvider = {
  getSession: () => Promise.resolve(null),
};

beforeAll(async () => {
  const result = await spinUpAuthTestDb();
  db = result.db;
});

describe('requireAuth', () => {
  it('returns session when provider resolves a session', async () => {
    const provider = new LocalTrustProvider();
    const session = await requireAuth(fakeRequest({}), provider);
    expect(session).toEqual({ userId: LOCAL_USER_ID, entityId: LOCAL_ENTITY_ID });
  });

  it('throws AuthError when provider returns null', async () => {
    await expect(requireAuth(fakeRequest({}), nullProvider)).rejects.toThrow(AuthError);
  });

  it('AuthError has code AUTH_REQUIRED', async () => {
    try {
      await requireAuth(fakeRequest({}), nullProvider);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).code).toBe('AUTH_REQUIRED');
    }
  });

  it('returns session for bearer-token provider with correct token', async () => {
    const provider = new BearerTokenProvider({ token: 'secret' });
    const session = await requireAuth(
      fakeRequest({ headers: { Authorization: 'Bearer secret' } }),
      provider,
    );
    expect(session.userId).toBe(LOCAL_USER_ID);
  });

  it('throws AuthError for bearer-token provider with wrong token', async () => {
    const provider = new BearerTokenProvider({ token: 'correct' });
    await expect(
      requireAuth(fakeRequest({ headers: { Authorization: 'Bearer wrong' } }), provider),
    ).rejects.toThrow(AuthError);
  });
});

describe('requireAuthWithEntity', () => {
  beforeAll(async () => {
    // Seed the local user+entity so entity membership exists
    await seedLocalUser(db);
  });

  it('returns session with entityId when entity membership exists', async () => {
    const provider = new LocalTrustProvider();
    const session = await requireAuthWithEntity(fakeRequest({}), provider, db);
    expect(session.userId).toBe(LOCAL_USER_ID);
    expect(session.entityId).toBe(LOCAL_ENTITY_ID);
  });

  it('throws AuthError when provider returns null (unauthenticated)', async () => {
    await expect(requireAuthWithEntity(fakeRequest({}), nullProvider, db)).rejects.toThrow(
      AuthError,
    );
  });

  it('throws NoEntityError when user has no entity membership', async () => {
    // Provider resolves a session for a user that has no entity_member row
    const orphanProvider: AuthProvider = {
      getSession: () =>
        Promise.resolve({ userId: '00000000-0000-0000-0000-000000000099', entityId: '' }),
    };
    await expect(requireAuthWithEntity(fakeRequest({}), orphanProvider, db)).rejects.toThrow(
      NoEntityError,
    );
  });

  it('NoEntityError has code NO_ENTITY', async () => {
    const orphanProvider: AuthProvider = {
      getSession: () =>
        Promise.resolve({ userId: '00000000-0000-0000-0000-000000000098', entityId: '' }),
    };
    try {
      await requireAuthWithEntity(fakeRequest({}), orphanProvider, db);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NoEntityError);
      expect((e as NoEntityError).code).toBe('NO_ENTITY');
    }
  });
});

describe('provider switching', () => {
  it('different providers can be used against the same db', async () => {
    // local-trust always succeeds
    const trustSession = await requireAuth(fakeRequest({}), new LocalTrustProvider());
    expect(trustSession.userId).toBe(LOCAL_USER_ID);

    // bearer-token with wrong token fails
    const bearer = new BearerTokenProvider({ token: 'tok' });
    await expect(requireAuth(fakeRequest({}), bearer)).rejects.toThrow(AuthError);

    // bearer-token with correct token succeeds
    const session = await requireAuth(
      fakeRequest({ headers: { Authorization: 'Bearer tok' } }),
      bearer,
    );
    expect(session.userId).toBe(LOCAL_USER_ID);
  });
});
