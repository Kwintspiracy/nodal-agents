import 'server-only';

import { createClient, eq, and, entityMembers } from '@nodal-agents/db';
import {
  LocalTrustProvider,
  LocalAuthProvider,
  createLocalAuthProvider,
  requireAuth,
  requireAuthWithEntity,
  type AuthProvider,
  type AuthSession,
} from '@nodal-agents/auth';
import { env } from './env.ts';

// Re-export helpers so callers only need to import from this module.
export { requireAuth, requireAuthWithEntity };
export type { AuthSession };

// ─── Active workspace (entity) selection ────────────────────────────────────────
// The dashboard lets a user own multiple workspaces (entities) and switch
// between them. The choice is stored in a cookie; the auth providers stay
// unchanged (they still resolve the user's DEFAULT entity), and we override
// `entityId` here — but ONLY when the user is actually a member of the cookie's
// entity. An invalid/forged cookie silently falls back to the default. The
// runner is unaffected (it gets entityId from the job row, not a cookie).

export const ACTIVE_ENTITY_COOKIE = 'nodalai_active_entity';

function readActiveEntityCookie(req: Request): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    if (k === ACTIVE_ENTITY_COOKIE) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

/**
 * Override the session's entityId with the active-workspace cookie, but only
 * when the user is genuinely a member of that entity (membership check against
 * entity_members). Absent or non-member cookie → unchanged default session.
 */
export async function applyActiveEntity(session: AuthSession, req: Request): Promise<AuthSession> {
  const cookieEntity = readActiveEntityCookie(req);
  if (!cookieEntity || cookieEntity === session.entityId) return session;
  const [member] = await getDb()
    .select({ id: entityMembers.id })
    .from(entityMembers)
    .where(and(eq(entityMembers.userId, session.userId), eq(entityMembers.entityId, cookieEntity)));
  if (!member) return session;
  return { ...session, entityId: cookieEntity };
}

// ─── DB singleton ──────────────────────────────────────────────────────────────
// One connection pool per server process. Cached on `globalThis` — NOT a plain
// module-level `let` — because `next dev` (Turbopack HMR) re-evaluates this
// module on every code change. A module-scoped singleton would be re-created
// each reload while the OLD pool stays open (its 10 connections never closed),
// so a long editing session leaks pools until Postgres hits `too many clients`.
// globalThis survives HMR, so the same pool is reused. No effect in production
// (no HMR — the module evaluates once anyway).
const dbGlobal = globalThis as unknown as {
  __nodalDb?: ReturnType<typeof createClient>;
};

export function getDb() {
  if (!dbGlobal.__nodalDb) {
    dbGlobal.__nodalDb = createClient(env.DATABASE_URL);
  }
  return dbGlobal.__nodalDb.db;
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

// ─── better-auth direct access ────────────────────────────────────────────────
// Returns the underlying better-auth instance so the API catch-all route
// (/api/auth/[...all]) can delegate requests directly to it.
// Only valid in local-auth mode — throws in any other mode.

export function getBetterAuth() {
  const provider = getAuthProvider();
  if (!(provider instanceof LocalAuthProvider)) {
    throw new Error('better-auth API is only available in local-auth mode');
  }
  return provider.auth;
}

// ─── Request-level helpers ─────────────────────────────────────────────────────

/**
 * Resolves the current user session from a Request object, or null.
 * Safe to call from Server Components and Server Actions.
 */
export async function getCurrentUser(req: Request): Promise<AuthSession | null> {
  const provider = getAuthProvider();
  const session = await provider.getSession(req);
  return session ? applyActiveEntity(session, req) : null;
}

/**
 * Resolves the session and throws AuthError if unauthenticated.
 * Use inside Server Actions that require a logged-in user.
 */
export async function requireUser(req: Request): Promise<AuthSession> {
  const session = await requireAuth(req, getAuthProvider());
  return applyActiveEntity(session, req);
}

/**
 * Resolves the session AND verifies the user has an entity membership.
 * Throws AuthError (unauthenticated) or NoEntityError (no workspace).
 */
export async function requireUserWithEntity(req: Request): Promise<AuthSession> {
  const session = await requireAuthWithEntity(req, getAuthProvider(), getDb());
  return applyActiveEntity(session, req);
}
