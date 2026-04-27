import 'server-only';

import { createClient } from '@nodalai/db';
import {
  LocalTrustProvider,
  LocalAuthProvider,
  createLocalAuthProvider,
  requireAuth,
  requireAuthWithEntity,
  type AuthProvider,
  type AuthSession,
} from '@nodalai/auth';
import { env } from './env.ts';

// Re-export helpers so callers only need to import from this module.
export { requireAuth, requireAuthWithEntity };
export type { AuthSession };

// ─── DB singleton ──────────────────────────────────────────────────────────────
// One connection pool per server process. Next.js may instantiate multiple
// workers, so each process gets its own pool — that's fine for a local install.

let _db: ReturnType<typeof createClient>['db'] | null = null;

export function getDb() {
  if (!_db) {
    const { db } = createClient(env.DATABASE_URL);
    _db = db;
  }
  return _db;
}

// ─── Auth provider singleton ───────────────────────────────────────────────────
// Provider is selected by AUTH_MODE env var. Default: local-trust (no auth).

let _authProvider: AuthProvider | null = null;

export function getAuthProvider(): AuthProvider {
  if (_authProvider) return _authProvider;

  if (env.AUTH_MODE === 'local-trust') {
    _authProvider = new LocalTrustProvider();
    return _authProvider;
  }

  if (env.AUTH_MODE === 'local-auth') {
    if (!env.AUTH_SECRET) {
      throw new Error('AUTH_SECRET must be set when AUTH_MODE=local-auth');
    }
    const provider: LocalAuthProvider = createLocalAuthProvider({
      db: getDb(),
      baseURL: env.NEXT_PUBLIC_APP_URL,
      secret: env.AUTH_SECRET,
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    });
    _authProvider = provider;
    return _authProvider;
  }

  // bearer-token — used for LAN/API mode (16c adds full wiring)
  // Fall back to local-trust for now so the scaffold doesn't crash.
  _authProvider = new LocalTrustProvider();
  return _authProvider;
}

// ─── Request-level helpers ─────────────────────────────────────────────────────

/**
 * Resolves the current user session from a Request object, or null.
 * Safe to call from Server Components and Server Actions.
 */
export async function getCurrentUser(req: Request): Promise<AuthSession | null> {
  const provider = getAuthProvider();
  return provider.getSession(req);
}

/**
 * Resolves the session and throws AuthError if unauthenticated.
 * Use inside Server Actions that require a logged-in user.
 */
export async function requireUser(req: Request): Promise<AuthSession> {
  return requireAuth(req, getAuthProvider());
}

/**
 * Resolves the session AND verifies the user has an entity membership.
 * Throws AuthError (unauthenticated) or NoEntityError (no workspace).
 */
export async function requireUserWithEntity(req: Request): Promise<AuthSession> {
  return requireAuthWithEntity(req, getAuthProvider(), getDb());
}
