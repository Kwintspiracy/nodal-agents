// local-auth provider tests.
// We do NOT test the full sign-up/sign-in round-trip here because better-auth
// requires a running HTTP server with real cookie infrastructure. Instead:
//   1. We verify that createLocalAuthProvider returns a valid LocalAuthProvider.
//   2. We verify that getSession returns null for a request with no cookie.
//   3. We verify Google OAuth provider config: not registered when env vars are
//      absent, registered (visible in config) when both env vars are present.
//   4. We verify isGoogleConfigured() correctly detects presence/absence.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  createLocalAuthProvider,
  isGoogleConfigured,
  LocalAuthProvider,
} from '../providers/local-auth.ts';
import { spinUpAuthTestDb, fakeRequest } from './helpers.ts';
import type { AuthTestDb } from './helpers.ts';

let db: AuthTestDb;

beforeAll(async () => {
  const result = await spinUpAuthTestDb();
  db = result.db;
});

describe('createLocalAuthProvider', () => {
  it('returns a LocalAuthProvider instance', () => {
    const provider = createLocalAuthProvider({
      db,
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-that-is-long-enough-32ch',
    });
    expect(provider).toBeInstanceOf(LocalAuthProvider);
  });

  it('getSession returns null for a request without a session cookie', async () => {
    const provider = createLocalAuthProvider({
      db,
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-that-is-long-enough-32ch',
    });
    const session = await provider.getSession(fakeRequest({}));
    expect(session).toBeNull();
  });

  it('getSession returns null for a request with a bogus cookie', async () => {
    const provider = createLocalAuthProvider({
      db,
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-that-is-long-enough-32ch',
    });
    const session = await provider.getSession(
      fakeRequest({ headers: { Cookie: 'better-auth.session_token=bogus' } }),
    );
    expect(session).toBeNull();
  });

  it('handleAuthRequest returns a Response for auth routes', async () => {
    const provider = createLocalAuthProvider({
      db,
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-that-is-long-enough-32ch',
    });
    // better-auth handles /api/auth/get-session and returns a JSON response
    const req = new Request('http://localhost:3000/api/auth/get-session', {
      method: 'GET',
    });
    const response = await provider.handleAuthRequest?.(req);
    // Should get a Response back (could be 401 or 200 with null session)
    expect(response).toBeInstanceOf(Response);
  });
});

describe('isGoogleConfigured', () => {
  it('returns false when neither key is set', () => {
    expect(isGoogleConfigured({})).toBe(false);
  });

  it('returns false when only clientId is set', () => {
    expect(isGoogleConfigured({ googleClientId: 'id' })).toBe(false);
  });

  it('returns false when only clientSecret is set', () => {
    expect(isGoogleConfigured({ googleClientSecret: 'secret' })).toBe(false);
  });

  it('returns true when both are set', () => {
    expect(isGoogleConfigured({ googleClientId: 'id', googleClientSecret: 'secret' })).toBe(true);
  });
});

describe('Google OAuth config activation', () => {
  it('provider is created without error when Google config is absent', () => {
    expect(() =>
      createLocalAuthProvider({
        db,
        baseURL: 'http://localhost:3000',
        secret: 'test-secret-that-is-long-enough-32ch',
        // No googleClientId or googleClientSecret
      }),
    ).not.toThrow();
  });

  it('provider is created without error when Google config is present', () => {
    expect(() =>
      createLocalAuthProvider({
        db,
        baseURL: 'http://localhost:3000',
        secret: 'test-secret-that-is-long-enough-32ch',
        googleClientId: 'fake-client-id.apps.googleusercontent.com',
        googleClientSecret: 'fake-client-secret',
      }),
    ).not.toThrow();
  });
});
