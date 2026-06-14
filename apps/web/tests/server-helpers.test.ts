/**
 * Smoke test: verifies that the server-side factory functions can be called
 * without errors and return the expected types.
 *
 * These tests run with a placeholder DATABASE_URL (no real DB connection is
 * made — factories are lazy). The goal is to confirm the module wiring is
 * correct, not to test DB queries.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Set env before importing server helpers (env.ts reads process.env at module level)
beforeAll(() => {
  process.env['DATABASE_URL'] = 'postgres://placeholder:5432/placeholder';
  process.env['AUTH_MODE'] = 'local-trust';
});

describe('getDb factory', () => {
  it('returns a drizzle db object (lazy — no real connection)', async () => {
    // Dynamic import to ensure env is set first
    const { getDb } = await import('../src/lib/server.ts');
    const db = getDb();
    // The drizzle instance has a `query` property
    expect(db).toBeDefined();
    expect(typeof db).toBe('object');
  });
});

describe('getAuthProvider factory', () => {
  it('returns a LocalTrustProvider in local-trust mode', async () => {
    const { getAuthProvider } = await import('../src/lib/server.ts');
    const provider = getAuthProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.getSession).toBe('function');
  });

  it('LocalTrustProvider always returns a session', async () => {
    const { getAuthProvider } = await import('../src/lib/server.ts');
    const provider = getAuthProvider();
    const session = await provider.getSession(new Request('http://localhost/'));
    expect(session).not.toBeNull();
    expect(session?.userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(session?.entityId).toBe('00000000-0000-0000-0000-000000000002');
  });
});

describe('env', () => {
  it('exports validated env object', async () => {
    const { env } = await import('../src/lib/env.ts');
    expect(env.AUTH_MODE).toBe('local-trust');
    expect(env.RUNNER_URL).toBe('http://127.0.0.1:3001');
  });

  it('NEXT_PUBLIC_AUTH_MODE defaults to local-trust when not set', async () => {
    const { env } = await import('../src/lib/env.ts');
    // Not set in beforeAll → should default to local-trust
    expect(env.NEXT_PUBLIC_AUTH_MODE).toBe('local-trust');
  });
});

describe('getBetterAuth', () => {
  it('throws when auth provider is not LocalAuthProvider (local-trust mode)', async () => {
    // The singleton was already initialized as LocalTrustProvider in the
    // getAuthProvider tests above — calling getBetterAuth must throw.
    const { getBetterAuth } = await import('../src/lib/server.ts');
    expect(() => getBetterAuth()).toThrow('better-auth API is only available in local-auth mode');
  });
});
