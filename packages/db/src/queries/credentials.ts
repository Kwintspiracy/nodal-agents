// queries/credentials.ts — pure DB helpers for credential fetch + decrypt + refresh.
// No Next.js imports, no 'use server', no revalidatePath.
// Caller is responsible for access control (ownership checks, session validation).

import { eq, sql } from 'drizzle-orm';
import { credentials, type CredentialRow } from '../schema/credentials.ts';
import { encrypt, decrypt, isEncrypted } from '@nodal-agents/secrets';
import { getProviderByCredentialType } from '@nodal-agents/shared';
import type {
  CredentialType,
  GoogleOauthPayload,
  NotionOauthPayload,
  AirtableOauthPayload,
} from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OauthPayload = GoogleOauthPayload | NotionOauthPayload | AirtableOauthPayload;

export type DecryptedCredential = {
  id: string;
  ownerUserId: string;
  name: string;
  type: CredentialType;
  payload: OauthPayload;
};

// Convenience alias — callers can use `Db` when they import this module.
export type Db = AnyDrizzleDb;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function decryptPayload(raw: string): OauthPayload {
  const json = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(json) as OauthPayload;
}

/**
 * Refresh threshold: trigger an auto-refresh when the access token expires
 * within this window. 60 seconds covers normal API call latency without
 * making refreshes too aggressive.
 */
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

function isPayloadExpiringSoon(payload: OauthPayload): boolean {
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
  return expiresAt !== null && expiresAt.getTime() - Date.now() < ACCESS_TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Perform the OAuth refresh POST and persist the result. Shared by the public
 * `refreshAndPersistCredential` (always refreshes — manual "force refresh")
 * and the auto-refresh path in `getDecryptedCredentialById` (only refreshes
 * when still stale after the advisory lock is acquired).
 *
 * `dbOrTx` may be a plain `Db` or a transaction handle — both expose the same
 * `.update()` query builder.
 */
async function doRefresh(
  dbOrTx: Db,
  credentialId: string,
  row: CredentialRow,
  payload: OauthPayload,
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const provider = getProviderByCredentialType(row.type as CredentialType);
  if (!provider) {
    throw new Error(`refreshAndPersistCredential: no provider for credential type '${row.type}'`);
  }

  if (!provider.supportsRefresh) {
    throw new Error(
      `refreshAndPersistCredential: provider '${provider.slug}' does not support token refresh`,
    );
  }

  const { clientId, clientSecret, refreshToken } = payload;

  if (!refreshToken) {
    throw new Error(
      `refreshAndPersistCredential: credential '${credentialId}' is missing refreshToken`,
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

  // audit#2 M-15: this call runs INSIDE a transaction holding a per-credential
  // pg_advisory_xact_lock (see getDecryptedCredentialById / callers below) — a
  // token endpoint that accepts the connection but never responds would hang
  // the transaction, and with it the advisory lock, blocking every other
  // concurrent refresh attempt for this credential indefinitely.
  let response: Response;
  try {
    response = await fetch(tokenUrl, { ...requestInit, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `refreshAndPersistCredential: token endpoint ${tokenUrl} timed out after 30000ms`,
      );
    }
    throw err;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `refreshAndPersistCredential: token endpoint returned ${response.status}: ${text}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const newAccessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null;
  if (!newAccessToken) {
    throw new Error(`refreshAndPersistCredential: token endpoint response missing 'access_token'`);
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

  await dbOrTx
    .update(credentials)
    .set({ payload: updatedEncrypted, updatedAt: new Date() })
    .where(eq(credentials.id, credentialId));

  return { accessToken: newAccessToken, expiresAt: newExpiresAt };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decrypt a credential row WITHOUT touching the network.
 *
 * Use this for read-only paths (UI list, display) that must not trigger an
 * OAuth refresh roundtrip — refresh is for the use-time path only. Returns
 * `null` when the row doesn't exist; bubbles up decrypt errors (master-key
 * mismatch / tampered ciphertext) to the caller so it can decide whether to
 * surface them.
 */
export async function decryptCredentialForDisplay(
  db: Db,
  credentialId: string,
): Promise<DecryptedCredential | null> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, credentialId));
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    type: row.type as CredentialType,
    payload: decryptPayload(row.payload),
  };
}

/**
 * Fetch + decrypt a credential by id, refreshing the access token if it's
 * past or near the 60s expiry threshold.
 *
 * NO ownership check — caller is responsible for access control
 * (the runner trusts the credential_id from agent_connector_assignments).
 *
 * On refresh failure (provider revoked integration, expired refresh_token,
 * network blip, etc.) the function falls back to the stale payload — the
 * caller's API call will likely 401, which is the signal to surface "user
 * must reconnect". We log at `warn` level — these are expected user-facing
 * events, not developer bugs.
 */
export async function getDecryptedCredentialById(
  db: Db,
  credentialId: string,
): Promise<DecryptedCredential | null> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, credentialId));
  if (!row) return null;

  let payload = decryptPayload(row.payload);
  const credentialType = row.type as CredentialType;

  // Auto-refresh path: if the token is past or near the expiry threshold AND
  // the provider can refresh AND we have a refresh token, mint a new access
  // token before handing the credential to the caller.
  if (isPayloadExpiringSoon(payload)) {
    const provider = getProviderByCredentialType(credentialType);
    if (provider?.supportsRefresh && payload.refreshToken) {
      try {
        // M-3: two concurrent jobs can both observe "expiring soon" and both
        // reach here at once. Without serialization they'd POST the SAME
        // refresh_token — the provider (Airtable/Google) rotates it on the
        // first request and 400s the second with invalid_grant, permanently
        // bricking the credential. pg_advisory_xact_lock serializes access
        // per-credential and auto-releases on COMMIT/ROLLBACK (transaction-
        // scoped, not session-scoped — no lock leak). The loser re-reads the
        // row after acquiring the lock: if the winner already refreshed it
        // past the expiry threshold, it skips the network call entirely
        // instead of burning the (now-rotated) refresh_token a second time.
        payload = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${credentialId}))`);
          const [freshRow] = await tx
            .select()
            .from(credentials)
            .where(eq(credentials.id, credentialId));
          if (!freshRow) return payload;
          const freshPayload = decryptPayload(freshRow.payload);
          if (!isPayloadExpiringSoon(freshPayload)) {
            // Already refreshed by the concurrent caller while we waited.
            return freshPayload;
          }
          const refreshed = await doRefresh(tx, credentialId, freshRow, freshPayload);
          return {
            ...freshPayload,
            accessToken: refreshed.accessToken,
            expiresAt: refreshed.expiresAt ? refreshed.expiresAt.toISOString() : null,
          };
        });
      } catch (err) {
        // Non-fatal: fall through with the stale payload. The caller's next
        // API call will 401 and the user will reconnect via /connectors.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[getDecryptedCredentialById] auto-refresh failed: ${message}`);
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
 * Perform the OAuth refresh roundtrip. Always refreshes (used by the manual
 * "force refresh" action) — unlike the auto-refresh path in
 * `getDecryptedCredentialById`, this never skips the network call based on
 * staleness.
 *
 * Persists new access_token + expires_at + rotated refresh_token (RFC 6749 §10.4).
 * Throws on missing refresh_token or provider error.
 * Returns the freshly-minted access token (in memory only — DB row is encrypted).
 *
 * M-3: wrapped in a transaction holding a per-credential advisory lock
 * (`pg_advisory_xact_lock`, released on COMMIT/ROLLBACK) so a concurrent
 * refresh of the SAME credential can't race this one. The row is re-read
 * AFTER the lock is acquired, so if a concurrent caller already rotated the
 * refresh_token while this call was waiting, the POST below uses the fresh
 * one — never the stale value read before the lock.
 */
export async function refreshAndPersistCredential(
  db: Db,
  credentialId: string,
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${credentialId}))`);

    const [row] = await tx.select().from(credentials).where(eq(credentials.id, credentialId));
    if (!row) {
      throw new Error(`refreshAndPersistCredential: credential '${credentialId}' not found`);
    }

    const payload = decryptPayload(row.payload);
    return doRefresh(tx, credentialId, row, payload);
  });
}
