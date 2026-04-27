// local-auth provider — better-auth wrapper.
// Supports email+password (always active when this provider is used).
// Supports Google OAuth when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
//
// Use the factory `createLocalAuthProvider(...)` — no module-level singletons.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth';
import { eq, users, sessions, accounts, verifications, entities, entityMembers } from '@nodalai/db';
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

    const userId = result.user.id;

    // Map better-auth user id → entity via entity_members table.
    const rows = await this.#db
      .select({ entityId: entityMembers.entityId })
      .from(entityMembers)
      .where(eq(entityMembers.userId, userId));

    let entityId: string;
    if (rows.length > 0 && rows[0]) {
      entityId = String(rows[0]['entityId']);
    } else {
      // Self-heal: any authenticated user without an entity gets one auto-created.
      // Covers users created BEFORE the post-signup hook was wired up, and any
      // edge case where the hook didn't fire (e.g., legacy import). Idempotent
      // because a successfully-created entity_member will be picked up by the
      // SELECT next time.
      entityId = crypto.randomUUID();
      const slug = `personal-${entityId.slice(0, 8)}`;
      await this.#db.insert(entities).values({
        id: entityId,
        userId,
        name: 'Personal',
        slug,
        icon: '🏠',
      });
      await this.#db.insert(entityMembers).values({
        entityId,
        userId,
        role: 'owner',
      });
    }

    return { userId, entityId };
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
    // Our `users.id` column is uuid, but better-auth's default ID generator
    // produces opaque strings (e.g. "k3IAKlN99X2Jp8n0imo7QHtlLwnPQMcf"). Postgres
    // rejects those with "invalid input syntax for type uuid". Override with
    // crypto.randomUUID() so user/session/account/verification all use UUIDs.
    advanced: {
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
    // Auto-create a personal entity (workspace) + entity_member row for each new
    // user. Without this, the user has no entity to scope their data and every
    // entity-filtered query returns "Failed to load" (entire app gates on entity).
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const entityId = crypto.randomUUID();
            const slug = `personal-${entityId.slice(0, 8)}`;
            await db.insert(entities).values({
              id: entityId,
              userId: user.id,
              name: 'Personal',
              slug,
              icon: '🏠',
            });
            await db.insert(entityMembers).values({
              entityId,
              userId: user.id,
              role: 'owner',
            });
          },
        },
      },
    },
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
