// local-auth provider — better-auth wrapper.
// Supports email+password (always active when this provider is used).
// Supports Google OAuth when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
//
// Use the factory `createLocalAuthProvider(...)` — no module-level singletons.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hashPassword } from 'better-auth/crypto';
import type { BetterAuthOptions } from 'better-auth';
import {
  eq,
  sql,
  users,
  sessions,
  accounts,
  verifications,
  entities,
  entityMembers,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AuthProvider, AuthSession } from '../types.ts';
import { isPrivateOrigin } from '../lib/private-origin.ts';

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

// ─── Setup state & owner claim ────────────────────────────────────────────────
// An install can arrive in local-auth mode by three routes, and the login page
// must behave differently for each:
//   'fresh' — no user at all (new install booted straight into local-auth):
//             the regular first-user sign-up applies.
//   'claim' — users exist but NO account (credential or social) exists: the
//             install was migrated from local-trust, so its owner has a user
//             row and a workspace but no way to sign in. Sign-up is closed
//             (the owner exists), so the ONLY working path is claiming the
//             owner account: attach an email + password to the existing user.
//   'ready' — at least one account exists: normal sign-in.

export type AuthSetupState = 'fresh' | 'claim' | 'ready';

/** Thrown by claimOwnerAccount — `code` is stable for UI mapping. */
export class ClaimError extends Error {
  readonly code: 'claim_closed' | 'claim_ambiguous' | 'claim_invalid';

  constructor(code: ClaimError['code'], message: string) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

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

  /** See AuthSetupState — decides which form the login page renders. */
  async getSetupState(): Promise<AuthSetupState> {
    const anyAccount = await this.#db.select({ id: accounts.id }).from(accounts).limit(1);
    if (anyAccount.length > 0) return 'ready';
    const anyUser = await this.#db.select({ id: users.id }).from(users).limit(1);
    return anyUser.length > 0 ? 'claim' : 'fresh';
  }

  /**
   * One-shot: attaches an email + credential (password) to the single existing
   * user of a migrated install, so its owner can sign in. Refuses once ANY
   * account exists (claim_closed) and when more than one user exists
   * (claim_ambiguous — no way to know which one is the owner; fail loud).
   *
   * The password is hashed with better-auth's own hashPassword so the regular
   * /api/auth/sign-in/email endpoint verifies it.
   */
  async claimOwnerAccount(input: { email: string; password: string }): Promise<{ userId: string }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ClaimError('claim_invalid', 'Enter a valid email address.');
    }
    if (input.password.length < 8) {
      throw new ClaimError('claim_invalid', 'Password must be at least 8 characters.');
    }

    // Hash outside the transaction — scrypt is slow by design and must not
    // hold the advisory lock (or a DB connection) for that long.
    const hashed = await hashPassword(input.password);

    return this.#db.transaction(async (tx) => {
      // Serializes concurrent claims: only one transaction at a time can be
      // past this point, so the accounts re-check below is race-free.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nodalai_claim_owner'))`);

      const anyAccount = await tx.select({ id: accounts.id }).from(accounts).limit(1);
      if (anyAccount.length > 0) {
        throw new ClaimError('claim_closed', 'This workspace already has a sign-in account.');
      }

      const userRows = await tx.select({ id: users.id, name: users.name }).from(users).limit(2);
      if (userRows.length === 0) {
        throw new ClaimError('claim_closed', 'No owner to claim. Create an account instead.');
      }
      if (userRows.length > 1) {
        throw new ClaimError(
          'claim_ambiguous',
          'Multiple users exist but none can sign in. Fix the install manually.',
        );
      }

      const owner = userRows[0]!;
      await tx
        .update(users)
        .set({
          email,
          name: owner.name || (email.split('@')[0] ?? email),
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, owner.id));

      await tx.insert(accounts).values({
        id: crypto.randomUUID(),
        userId: owner.id,
        providerId: 'credential',
        accountId: owner.id,
        password: hashed,
      });

      return { userId: owner.id };
    });
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
    // CSRF: better-auth rejects auth requests whose Origin header doesn't match
    // baseURL or trustedOrigins. In LAN mode the user accesses the dashboard
    // via http://<lan-ip>:3000 from another device, so we additionally trust any
    // Origin pointing at a loopback or RFC1918 private address. Public IPs are
    // never trusted, so a malicious site cannot mount a CSRF.
    trustedOrigins: (request) => {
      const origins = [baseURL];
      const origin = request?.headers.get('origin') ?? null;
      if (origin && isPrivateOrigin(origin)) origins.push(origin);
      return origins;
    },
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
          before: async (user) => {
            // MED-2 (audit sécu 2026-07-07): close open sign-up once the owner
            // exists. In local-auth on a LAN bind, open sign-up lets ANY
            // reachable host create an account — and each new user auto-gets
            // its own entity below (an unauthenticated foothold). The FIRST
            // user (owner onboarding) is allowed; afterwards sign-up is closed.
            // Set NODALAI_ALLOW_OPEN_SIGNUP=1 to keep it open for a deliberate
            // multi-user install (a real invite flow would replace this).
            if (process.env['NODALAI_ALLOW_OPEN_SIGNUP'] !== '1') {
              const [existing] = await db.select({ id: users.id }).from(users).limit(1);
              if (existing) {
                throw new Error('Sign-up is closed: this workspace already has an owner.');
              }
            }
            return { data: user };
          },
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
