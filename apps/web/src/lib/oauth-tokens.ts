// oauth-tokens.ts — persist / refresh / decrypt helpers for OAuth connectors.
// Consumed by: the OAuth callback route (Agent A) and refreshConnectorAction (actions.ts).
// No "use server" — this is a plain server-side module imported by server-only callers.

import 'server-only';
import { revalidatePath } from 'next/cache';
import { eq, and, connectors } from '@nodalai/db';
import { encrypt, decrypt, isEncrypted } from '@nodalai/secrets';
import { getDb } from './server.ts';
import { CONNECTOR_CATALOG } from './connector-catalog.ts';
import { getOAuthProvider } from './oauth-providers.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PersistOauthTokensOpts = {
  entityId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
  accessToken: string;
  expiresAt: Date | null;
  scopes: string | null;
  accountName: string | null;
  tokenUrl: string;
  name?: string;
};

export type DecryptedConnector = {
  id: string;
  slug: string;
  entityId: string | null;
  name: string;
  authType: string;
  active: boolean;
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  accountName: string | null;
  tokenUrl: string | null;
  apiKey: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decrypt a nullable string value if it carries the enc:v1: prefix.
 * Returns null for null input. Returns the value as-is if not encrypted
 * (legacy plaintext support — upgraded on next save).
 */
function maybeDecrypt(value: string | null): string | null {
  if (value === null) return null;
  if (value === '') return null;
  if (isEncrypted(value)) return decrypt(value);
  // Legacy plaintext — return as-is so existing connectors still work.
  return value;
}

/**
 * Idempotent encrypt: if the value is already encrypted, return it unchanged.
 * If null, return null. Otherwise encrypt.
 */
function encryptIdempotent(value: string | null): string | null {
  if (value === null || value === '') return null;
  if (isEncrypted(value)) return value;
  return encrypt(value);
}

// ─── persistOauthTokens ───────────────────────────────────────────────────────

/**
 * Upsert an OAuth connector row with encrypted tokens.
 * Keyed by (entityId, slug). Called by the OAuth callback route after a
 * successful token exchange.
 */
export async function persistOauthTokens(opts: PersistOauthTokensOpts): Promise<{ id: string }> {
  const catalog = CONNECTOR_CATALOG.find((c) => c.slug === opts.slug);
  if (!catalog) {
    throw new Error(`persistOauthTokens: unknown connector slug '${opts.slug}'`);
  }

  const db = getDb();

  // Encrypt sensitive fields.
  const encClientSecret = encryptIdempotent(opts.clientSecret);
  const encRefreshToken = encryptIdempotent(opts.refreshToken);
  const encAccessToken = encryptIdempotent(opts.accessToken);

  const name = opts.name ?? catalog.label;

  const fields = {
    name,
    authType: 'oauth2' as const,
    active: true,
    oauthClientId: opts.clientId,
    oauthClientSecret: encClientSecret,
    oauthRefreshToken: encRefreshToken,
    oauthAccessToken: encAccessToken,
    oauthTokenExpiresAt: opts.expiresAt,
    oauthTokenUrl: opts.tokenUrl,
    oauthScopes: opts.scopes,
    oauthAccountName: opts.accountName,
    updatedAt: new Date(),
  };

  const [existing] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(and(eq(connectors.entityId, opts.entityId), eq(connectors.slug, opts.slug)));

  if (existing) {
    await db.update(connectors).set(fields).where(eq(connectors.id, existing.id));
    revalidatePath('/connectors');
    return { id: existing.id };
  }

  const [row] = await db
    .insert(connectors)
    .values({
      entityId: opts.entityId,
      slug: opts.slug,
      ...fields,
    })
    .returning({ id: connectors.id });

  if (!row) {
    throw new Error('persistOauthTokens: insert returned no row');
  }

  revalidatePath('/connectors');
  return { id: row.id };
}

// ─── refreshOauthAccessToken ──────────────────────────────────────────────────

/**
 * Perform a token refresh for the given connector.
 * Updates the DB with a newly encrypted access token + expiry.
 * Returns the plaintext access token in memory only — never persisted as plaintext.
 *
 * Throws if:
 *   - connector not found
 *   - authType !== 'oauth2'
 *   - provider does not support refresh (e.g. Notion)
 *   - clientSecret or refreshToken are missing
 *   - token endpoint returns an error
 */
export async function refreshOauthAccessToken(
  connectorId: string,
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const db = getDb();

  const [row] = await db.select().from(connectors).where(eq(connectors.id, connectorId));

  if (!row) {
    throw new Error(`refreshOauthAccessToken: connector '${connectorId}' not found`);
  }

  if (row.authType !== 'oauth2') {
    throw new Error(
      `refreshOauthAccessToken: connector '${connectorId}' has authType '${row.authType}', not 'oauth2'`,
    );
  }

  const provider = getOAuthProvider(row.slug);
  if (!provider) {
    throw new Error(`refreshOauthAccessToken: no OAuth provider registered for slug '${row.slug}'`);
  }

  if (!provider.supportsRefresh) {
    throw new Error(
      `refreshOauthAccessToken: provider '${row.slug}' does not support token refresh`,
    );
  }

  const clientSecret = maybeDecrypt(row.oauthClientSecret);
  const refreshToken = maybeDecrypt(row.oauthRefreshToken);

  if (!clientSecret) {
    throw new Error(`refreshOauthAccessToken: connector '${connectorId}' is missing clientSecret`);
  }
  if (!refreshToken) {
    throw new Error(`refreshOauthAccessToken: connector '${connectorId}' is missing refreshToken`);
  }

  // Build request according to tokenAuth strategy.
  const tokenUrl = provider.tokenUrl;
  let requestInit: RequestInit;

  if (provider.tokenBodyType === 'form') {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    if (provider.tokenAuth === 'body') {
      body.set('client_id', row.oauthClientId ?? '');
      body.set('client_secret', clientSecret);
    }

    requestInit = {
      method: 'POST',
      headers:
        provider.tokenAuth === 'basic'
          ? {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${Buffer.from(`${row.oauthClientId ?? ''}:${clientSecret}`).toString('base64')}`,
            }
          : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    };
  } else {
    // json body
    const bodyObj: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    };

    if (provider.tokenAuth === 'body') {
      bodyObj['client_id'] = row.oauthClientId ?? '';
      bodyObj['client_secret'] = clientSecret;
    }

    requestInit = {
      method: 'POST',
      headers:
        provider.tokenAuth === 'basic'
          ? {
              'Content-Type': 'application/json',
              Authorization: `Basic ${Buffer.from(`${row.oauthClientId ?? ''}:${clientSecret}`).toString('base64')}`,
            }
          : { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    };
  }

  const response = await fetch(tokenUrl, requestInit);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`refreshOauthAccessToken: token endpoint returned ${response.status}: ${text}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  const newAccessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null;
  if (!newAccessToken) {
    throw new Error(`refreshOauthAccessToken: token endpoint response missing 'access_token'`);
  }

  const expiresInSeconds = typeof json['expires_in'] === 'number' ? json['expires_in'] : null;
  const expiresAt =
    expiresInSeconds !== null ? new Date(Date.now() + expiresInSeconds * 1000) : null;

  // Persist encrypted new access token.
  await db
    .update(connectors)
    .set({
      oauthAccessToken: encrypt(newAccessToken),
      oauthTokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(connectors.id, connectorId));

  revalidatePath('/connectors');

  return { accessToken: newAccessToken, expiresAt };
}

// ─── getDecryptedConnector ────────────────────────────────────────────────────

/**
 * Fetch and decrypt all sensitive fields for a connector row.
 * NO entity ownership check — callers are responsible for access control.
 * Intended for internal/runner use (e.g. adapter resolution).
 *
 * Supports legacy plaintext values: if a field is not encrypted (no enc:v1: prefix)
 * it is returned as-is. Encrypted fields are decrypted in memory.
 */
export async function getDecryptedConnector(connectorId: string): Promise<DecryptedConnector> {
  const db = getDb();

  const [row] = await db.select().from(connectors).where(eq(connectors.id, connectorId));

  if (!row) {
    throw new Error(`getDecryptedConnector: connector '${connectorId}' not found`);
  }

  return {
    id: row.id,
    slug: row.slug,
    entityId: row.entityId,
    name: row.name,
    authType: row.authType,
    active: row.active ?? true,
    clientId: row.oauthClientId,
    clientSecret: maybeDecrypt(row.oauthClientSecret),
    refreshToken: maybeDecrypt(row.oauthRefreshToken),
    accessToken: maybeDecrypt(row.oauthAccessToken),
    expiresAt: row.oauthTokenExpiresAt,
    scopes: row.oauthScopes,
    accountName: row.oauthAccountName,
    tokenUrl: row.oauthTokenUrl,
    apiKey: maybeDecrypt(row.apiKey),
  };
}
