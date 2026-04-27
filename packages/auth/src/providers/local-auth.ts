// local-auth provider — better-auth wrapper.
// Supports email+password (always active when this provider is used).
// Supports Google OAuth when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
//
// Use the factory `createLocalAuthProvider(...)` — no module-level singletons.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth';
import { eq, users, sessions, accounts, verifications } from '@nodalai/db';
import type { AnyDrizzleDb } from '@nodalai/db';
import type { AuthProvider, AuthSession } from '../types.ts';

// ─── Factory options ──────────────────────────────────────────────────────────

export interface LocalAuthProviderOptions {
  /** Drizzle db instance (postgres-js or pglite). */
  db: AnyDrizzleDb;
  /** Required: base URL of the server (e.g. "http://localhost:3000"). */
  baseURL: string;
  /**
   * Used as the HMAC secret for session cookies.
   * Must be at least 32 characters in production.
   */
  secret: string;
  /** Google OAuth client ID — activates Google provider when both are set. */
  googleClientId?: string;
  /** Google OAuth client secret — activates Google provider when both are set. */
  googleClientSecret?: string;
}

// ─── Internal type alias ──────────────────────────────────────────────────────
// We store the instance as the base BetterAuthOptions generic to avoid leaking
// the concrete Options type out of the factory.

type BetterAuthInstance = ReturnType<typeof betterAuth<BetterAuthOptions>>;

// ─── Provider class ───────────────────────────────────────────────────────────

export class LocalAuthProvider implements AuthProvider {
  readonly #auth: BetterAuthInstance;
  readonly #db: AnyDrizzleDb;

  constructor(auth: BetterAuthInstance, db: AnyDrizzleDb) {
    this.#auth = auth;
    this.#db = db;
  }

  /**
   * Exposes the underlying better-auth instance so the Next.js API catch-all
   * route can delegate requests to it via `toNextJsHandler`.
   */
  get auth(): BetterAuthInstance {
    return this.#auth;
  }

  async getSession(req: Request): Promise<AuthSession | null> {
    // Use better-auth's built-in session resolution.
    // Returns null (via catch) when no valid session cookie is present.
    const result = await this.#auth.api.getSession({ headers: req.headers }).catch(() => null);

    if (!result?.session || !result?.user) return null;

    // Map better-auth user id → entity via entity_members table.
    const { entityMembers } = await import('@nodalai/db/schema');
    const userId = result.user.id;

    const rows = await this.#db
      .select({ entityId: entityMembers.entityId })
      .from(entityMembers)
      .where(eq(entityMembers.userId, userId));

    if (rows.length === 0) return null;
    const first = rows[0];
    if (!first) return null;

    return {
      userId,
      entityId: String(first['entityId']),
    };
  }

  async handleAuthRequest(req: Request): Promise<Response | null> {
    // Let better-auth handle auth routes. Returns null (via catch) on errors.
    return this.#auth.handler(req).catch(() => null);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a LocalAuthProvider with better-auth configured against the given
 * Drizzle instance. Caller owns the DB connection.
 */
export function createLocalAuthProvider(options: LocalAuthProviderOptions): LocalAuthProvider {
  const { db, baseURL, secret, googleClientId, googleClientSecret } = options;

  const socialProviders: BetterAuthOptions['socialProviders'] = {};

  // Only configure Google OAuth when both env vars are present.
  if (googleClientId && googleClientSecret) {
    socialProviders['google'] = { clientId: googleClientId, clientSecret: googleClientSecret };
  }

  const authOptions: BetterAuthOptions = {
    baseURL,
    secret,
    database: drizzleAdapter(db, {
      provider: 'pg',
      // camelCase: Drizzle maps column names to JS field names (userId, expiresAt…)
      camelCase: true,
      // Pass the schema explicitly. Without this, better-auth's adapter
      // pluralizes its singular model names ('user' → 'userss', 'session' →
      // 'sessionss') and fails to find any of our tables. With an explicit
      // schema map, our table objects are used directly.
      schema: {
        users,
        sessions,
        accounts,
        verifications,
      },
    }),
    // Map better-auth's "user" model to our extended `users` table.
    user: {
      modelName: 'users',
      fields: {
        name: 'name',
        email: 'email',
        emailVerified: 'emailVerified',
        image: 'image',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'userId',
        expiresAt: 'expiresAt',
        token: 'token',
        ipAddress: 'ipAddress',
        userAgent: 'userAgent',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        userId: 'userId',
        providerId: 'providerId',
        accountId: 'accountId',
        accessToken: 'accessToken',
        refreshToken: 'refreshToken',
        idToken: 'idToken',
        accessTokenExpiresAt: 'accessTokenExpiresAt',
        refreshTokenExpiresAt: 'refreshTokenExpiresAt',
        scope: 'scope',
        password: 'password',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: {
        identifier: 'identifier',
        value: 'value',
        expiresAt: 'expiresAt',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    emailAndPassword: {
      enabled: true,
    },
    socialProviders,
  };

  const auth = betterAuth(authOptions) as BetterAuthInstance;

  return new LocalAuthProvider(auth, db);
}

// ─── Google config presence helper ───────────────────────────────────────────

/** Returns true when both Google env vars are available to enable the provider. */
export function isGoogleConfigured(options: {
  googleClientId?: string;
  googleClientSecret?: string;
}): boolean {
  return Boolean(options.googleClientId && options.googleClientSecret);
}
