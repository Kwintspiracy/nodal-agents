'use server';

// credentials.ts — server actions + internal helpers for credential lifecycle.
// Server actions (listCredentialsAction, deleteCredentialAction, etc.) never return
// the decrypted payload. Internal helpers (getDecryptedCredential, persist*,
// refresh*) are server-only and return plaintext in memory.

import 'server-only';
import { revalidatePath } from 'next/cache';
import { eq } from '@nodalai/db';
import { credentials, connectors } from '@nodalai/db';
import { encrypt, decrypt, isEncrypted } from '@nodalai/secrets';
import { z } from 'zod';
import type {
  CredentialType,
  GoogleOauthPayload,
  NotionOauthPayload,
  AirtableOauthPayload,
} from '@nodalai/shared';
import { getDb, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodalai/auth';
import { headers } from 'next/headers';
import { getProviderByCredentialType } from './oauth-providers.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OauthPayload = GoogleOauthPayload | NotionOauthPayload | AirtableOauthPayload;

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  return requireAuth(req, provider);
}

// ─── Decrypt helper ───────────────────────────────────────────────────────────

function decryptPayload(raw: string): OauthPayload {
  const json = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(json) as OauthPayload;
}

// ─── SERVER ACTIONS ───────────────────────────────────────────────────────────

export type CredentialListItem = {
  id: string;
  name: string;
  type: CredentialType;
  accountName: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  inUseBy: { connectorSlug: string; connectorId: string }[];
  createdAt: Date | null;
  updatedAt: Date | null;
};

/**
 * List credentials owned by the current user.
 * Decrypts payload only to extract display fields; never returns full payload.
 */
export async function listCredentialsAction(
  filterType?: CredentialType,
): Promise<ActionResult<CredentialListItem[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    const rows = await db
      .select()
      .from(credentials)
      .where(eq(credentials.ownerUserId, session.userId));

    const filtered = filterType !== undefined ? rows.filter((r) => r.type === filterType) : rows;

    const items: CredentialListItem[] = await Promise.all(
      filtered.map(async (row) => {
        // Decrypt to read display-only fields, then discard.
        let accountName: string | null = null;
        let expiresAt: Date | null = null;
        let scopes: string | null = null;
        try {
          const payload = decryptPayload(row.payload);
          accountName = payload.accountName ?? null;
          expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
          scopes = payload.scopes ?? null;
        } catch {
          // Non-fatal — display as unknown
        }

        // Connectors using this credential
        const usageRows = await db
          .select({ id: connectors.id, slug: connectors.slug })
          .from(connectors)
          .where(eq(connectors.credentialId, row.id));

        const inUseBy = usageRows.map((u) => ({
          connectorSlug: u.slug,
          connectorId: u.id,
        }));

        return {
          id: row.id,
          name: row.name,
          type: row.type as CredentialType,
          accountName,
          expiresAt,
          scopes,
          inUseBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );

    return ok(items);
  } catch (err) {
    console.error('[listCredentialsAction]', err);
    return fail('db_error', 'Failed to load credentials');
  }
}

/**
 * Delete a credential owned by the current user.
 * ON DELETE SET NULL on the FK disconnects all connectors referencing it.
 * Returns the count of connectors disconnected.
 */
export async function deleteCredentialAction(
  id: string,
): Promise<ActionResult<{ disconnected: number }>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid credential id');
    }
    const db = getDb();

    const [existing] = await db
      .select({ id: credentials.id, ownerUserId: credentials.ownerUserId })
      .from(credentials)
      .where(eq(credentials.id, id));

    if (!existing) return fail('not_found', 'Credential not found');
    if (existing.ownerUserId !== session.userId) return fail('forbidden', 'Access denied');

    // Count connectors that will be disconnected
    const usageRows = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.credentialId, id));
    const disconnected = usageRows.length;

    await db.delete(credentials).where(eq(credentials.id, id));

    revalidatePath('/credentials');
    revalidatePath('/connectors');
    return ok({ disconnected });
  } catch (err) {
    console.error('[deleteCredentialAction]', err);
    return fail('db_error', 'Failed to delete credential');
  }
}

/**
 * Rename a credential owned by the current user.
 */
export async function renameCredentialAction(
  id: string,
  name: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid credential id');
    }
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 120) {
      return fail('validation_failed', 'Name must be 1–120 characters');
    }
    const db = getDb();

    const [existing] = await db
      .select({ id: credentials.id, ownerUserId: credentials.ownerUserId })
      .from(credentials)
      .where(eq(credentials.id, id));

    if (!existing) return fail('not_found', 'Credential not found');
    if (existing.ownerUserId !== session.userId) return fail('forbidden', 'Access denied');

    await db
      .update(credentials)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(credentials.id, id));

    revalidatePath('/credentials');
    return ok(undefined);
  } catch (err) {
    console.error('[renameCredentialAction]', err);
    return fail('db_error', 'Failed to rename credential');
  }
}

/**
 * Refresh the OAuth access token for a credential owned by the current user.
 * Returns only the new expiresAt (access token never surfaced to client).
 */
export async function refreshCredentialAction(
  id: string,
): Promise<ActionResult<{ expiresAt: Date | null }>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid credential id');
    }
    const db = getDb();

    const [existing] = await db
      .select({ id: credentials.id, ownerUserId: credentials.ownerUserId })
      .from(credentials)
      .where(eq(credentials.id, id));

    if (!existing) return fail('not_found', 'Credential not found');
    if (existing.ownerUserId !== session.userId) return fail('forbidden', 'Access denied');

    const { expiresAt } = await refreshCredentialAccessToken(id);
    revalidatePath('/credentials');
    return ok({ expiresAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[refreshCredentialAction]', err);
    if (message.includes('does not support token refresh')) {
      return fail('oauth_no_refresh', 'This provider does not support token refresh');
    }
    if (message.includes('missing refreshToken')) {
      return fail('missing_refresh_token', 'Credential is missing refresh token');
    }
    return fail('refresh_failed', `Token refresh failed: ${message}`);
  }
}

// ─── INTERNAL HELPERS (server-only, return decrypted payload) ─────────────────

export type DecryptedCredential = {
  id: string;
  ownerUserId: string;
  name: string;
  type: CredentialType;
  payload: OauthPayload;
};

/**
 * Refresh threshold: trigger an auto-refresh when the access token expires
 * within this window. 60 seconds covers normal API call latency without
 * making refreshes too aggressive.
 */
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Fetch and decrypt a credential row.
 * NO ownership check — callers are responsible for access control.
 * Intended for internal flows (refresh, runner adapter resolution).
 *
 * Auto-refresh: if the credential's access token is expired or expires
 * within 60s AND the provider supports refresh AND a refresh token is
 * stored, this call refreshes the token transparently before returning.
 * On refresh failure, returns the stale payload (caller can still attempt
 * the API call and fall back to a 401-driven flow if needed).
 */
export async function getDecryptedCredential(id: string): Promise<DecryptedCredential | null> {
  const db = getDb();
  const [row] = await db.select().from(credentials).where(eq(credentials.id, id));
  if (!row) return null;

  let payload = decryptPayload(row.payload);
  const credentialType = row.type as CredentialType;

  // Auto-refresh path: if the token is past or near the expiry threshold AND
  // the provider can refresh AND we have a refresh token, mint a new access
  // token before handing the credential to the caller.
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
  const isExpiringSoon =
    expiresAt !== null && expiresAt.getTime() - Date.now() < ACCESS_TOKEN_REFRESH_BUFFER_MS;

  if (isExpiringSoon) {
    const provider = getProviderByCredentialType(credentialType);
    if (provider?.supportsRefresh && payload.refreshToken) {
      try {
        await refreshCredentialAccessToken(id);
        // Re-read the row to pick up the updated payload (encrypted).
        const [refreshedRow] = await db.select().from(credentials).where(eq(credentials.id, id));
        if (refreshedRow) {
          payload = decryptPayload(refreshedRow.payload);
        }
      } catch (err) {
        // Non-fatal: fall through with the stale payload. The caller's API
        // call will likely 401, which is the correct signal to surface to
        // the user (re-auth needed). Logging gives operators a trail.
        console.error('[getDecryptedCredential] auto-refresh failed', err);
      }
    }
  }

  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    type: credentialType,
    payload,
  };
}

/**
 * Insert a new credential row from an OAuth flow.
 * Always INSERTs — no upsert. Each flow creates a distinct credential.
 * Returns the new credential id.
 */
export async function persistCredentialFromOauthFlow(opts: {
  ownerUserId: string;
  credentialType: CredentialType;
  name: string;
  payload: OauthPayload;
}): Promise<{ id: string }> {
  const { ownerUserId, credentialType, name, payload } = opts;
  const db = getDb();

  // Serialize + encrypt payload
  const rawJson = JSON.stringify(payload);
  const encryptedPayload = isEncrypted(rawJson) ? rawJson : encrypt(rawJson);

  const [row] = await db
    .insert(credentials)
    .values({
      ownerUserId,
      name,
      type: credentialType,
      payload: encryptedPayload,
    })
    .returning({ id: credentials.id });

  if (!row) {
    throw new Error('persistCredentialFromOauthFlow: insert returned no row');
  }

  revalidatePath('/credentials');
  return { id: row.id };
}

/**
 * Perform a token refresh for the given credential.
 * Resolves the provider via credential.type, POSTs to tokenUrl with refresh_token grant.
 * Updates the DB row (encrypted), returns plaintext accessToken in memory only.
 */
export async function refreshCredentialAccessToken(credentialId: string): Promise<{
  accessToken: string;
  expiresAt: Date | null;
}> {
  const db = getDb();

  const [row] = await db.select().from(credentials).where(eq(credentials.id, credentialId));
  if (!row) {
    throw new Error(`refreshCredentialAccessToken: credential '${credentialId}' not found`);
  }

  const payload = decryptPayload(row.payload);

  const provider = getProviderByCredentialType(row.type as CredentialType);
  if (!provider) {
    throw new Error(`refreshCredentialAccessToken: no provider for credential type '${row.type}'`);
  }

  if (!provider.supportsRefresh) {
    throw new Error(
      `refreshCredentialAccessToken: provider '${provider.slug}' does not support token refresh`,
    );
  }

  const { clientId, clientSecret, refreshToken } = payload;

  if (!refreshToken) {
    throw new Error(
      `refreshCredentialAccessToken: credential '${credentialId}' is missing refreshToken`,
    );
  }

  // Build token request
  const tokenUrl = provider.tokenUrl;
  let requestInit: RequestInit;

  if (provider.tokenBodyType === 'form') {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    if (provider.tokenAuth === 'body') {
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);
    }

    requestInit = {
      method: 'POST',
      headers:
        provider.tokenAuth === 'basic'
          ? {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
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
      bodyObj['client_id'] = clientId;
      bodyObj['client_secret'] = clientSecret;
    }

    requestInit = {
      method: 'POST',
      headers:
        provider.tokenAuth === 'basic'
          ? {
              'Content-Type': 'application/json',
              Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            }
          : { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    };
  }

  const response = await fetch(tokenUrl, requestInit);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `refreshCredentialAccessToken: token endpoint returned ${response.status}: ${text}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const newAccessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null;
  if (!newAccessToken) {
    throw new Error(`refreshCredentialAccessToken: token endpoint response missing 'access_token'`);
  }

  const expiresInSeconds = typeof json['expires_in'] === 'number' ? json['expires_in'] : null;
  const newExpiresAt =
    expiresInSeconds !== null ? new Date(Date.now() + expiresInSeconds * 1000) : null;

  // RFC 6749 §6 + §10.4: many providers rotate the refresh_token on every refresh
  // (Airtable, GitHub, certain Google flows). They issue a new refresh_token in the
  // response and invalidate the previous one. If we don't store the new one, the
  // next refresh fails with `invalid_grant: Invalid token`. If the provider does
  // NOT rotate (no `refresh_token` in the response), keep the existing one.
  const newRefreshToken = typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null;

  // Update the payload with new access token + expiry (+ rotated refresh if any), re-encrypt
  const updatedPayload: OauthPayload = {
    ...payload,
    accessToken: newAccessToken,
    expiresAt: newExpiresAt ? newExpiresAt.toISOString() : null,
    refreshToken: newRefreshToken ?? payload.refreshToken,
  };
  const updatedEncrypted = encrypt(JSON.stringify(updatedPayload));

  await db
    .update(credentials)
    .set({ payload: updatedEncrypted, updatedAt: new Date() })
    .where(eq(credentials.id, credentialId));

  return { accessToken: newAccessToken, expiresAt: newExpiresAt };
}
