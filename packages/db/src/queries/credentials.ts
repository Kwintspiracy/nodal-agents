// queries/credentials.ts — pure DB helpers for credential fetch + decrypt + refresh.
// No Next.js imports, no 'use server', no revalidatePath.
// Caller is responsible for access control (ownership checks, session validation).

import { eq, sql } from 'drizzle-orm';
import { credentials, type CredentialRow } from '../schema/credentials.ts';
import { encrypt, decrypt, isEncrypted } from '@nodal-agents/secrets';
import {
  ConnectionUnavailableError,
  attemptDue,
  connectionState,
  getProviderByCredentialType,
  networkFailure,
  tokenEndpointFailure,
  type ConnectionRef,
  type ConnectionState,
} from '@nodal-agents/shared';
import type {
  CredentialType,
  GoogleOauthPayload,
  NotionOauthPayload,
  AirtableOauthPayload,
  MicrosoftOauthPayload,
} from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { readConnectionState, recordConnectionState } from './connection-states.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OauthPayload =
  | GoogleOauthPayload
  | NotionOauthPayload
  | AirtableOauthPayload
  | MicrosoftOauthPayload;

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

/** Whether the stored access token is still accepted by its expiry (a fact, not a guess). */
function isAccessTokenStillValid(payload: OauthPayload): boolean {
  return !payload.expiresAt || new Date(payload.expiresAt).getTime() > Date.now();
}

function credentialRef(credentialId: string): ConnectionRef {
  return { kind: 'credential', id: credentialId };
}

/** A refresh that did not produce a usable token, with the state it puts the credential in. */
class RefreshFailure extends Error {
  readonly connection: ConnectionState;
  constructor(connection: ConnectionState, message: string) {
    super(message);
    this.name = 'RefreshFailure';
    this.connection = connection;
  }
}

/** The state any failure of a refresh puts the credential in. */
function refreshFailureState(err: unknown): ConnectionState {
  if (err instanceof RefreshFailure) return err.connection;
  return (
    networkFailure(err) ??
    connectionState('unreachable', 'network', err instanceof Error ? err.message : String(err))
  );
}

/**
 * Record what a refresh learnt. A failure to record is logged and does not
 * hide the refresh's own outcome from the caller.
 */
async function recordRefreshOutcome(
  db: Db,
  credentialId: string,
  connection: ConnectionState,
): Promise<void> {
  try {
    await recordConnectionState(db, credentialRef(credentialId), connection);
  } catch (err) {
    console.error(
      `[credentials] recording state '${connection.state}' of credential ${credentialId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
    throw new RefreshFailure(
      connectionState(
        'broken',
        'config_incomplete',
        `no provider for credential type '${row.type}'`,
      ),
      `refreshAndPersistCredential: no provider for credential type '${row.type}'`,
    );
  }

  if (!provider.supportsRefresh) {
    throw new RefreshFailure(
      connectionState('needs_reauth', 'no_refresh', null),
      `refreshAndPersistCredential: provider '${provider.slug}' does not support token refresh`,
    );
  }

  const { clientId, clientSecret, refreshToken } = payload;

  if (!refreshToken) {
    throw new RefreshFailure(
      connectionState('needs_reauth', 'no_refresh', null),
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
    throw new RefreshFailure(
      refreshFailureState(err),
      err instanceof Error && err.name === 'TimeoutError'
        ? `refreshAndPersistCredential: token endpoint ${tokenUrl} timed out after 30000ms`
        : `refreshAndPersistCredential: token endpoint ${tokenUrl} unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // The provider's answer, classified by RFC 6749 section 5.2: `invalid_grant`
    // means the grant ended (revoked, expired, or the seven-day limit of an
    // app left in testing), so the credential needs the person to authorise
    // again.
    throw new RefreshFailure(
      tokenEndpointFailure(response.status, text),
      `refreshAndPersistCredential: token endpoint returned ${response.status}: ${text}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const newAccessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null;
  if (!newAccessToken) {
    throw new RefreshFailure(
      connectionState('unreachable', 'provider_unavailable', 'token response without access_token'),
      `refreshAndPersistCredential: token endpoint response missing 'access_token'`,
    );
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

  // A rotated refresh token is never lost (FK2-14). The provider's answer is
  // written FIRST, before the new access token leaves this function, together
  // with the state it proves (`working`). The write runs in a savepoint and is
  // attempted twice, so one failed statement (a lock time-out, a transient
  // error) does not discard the answer: the savepoint rolls back alone and the
  // second attempt stores it. The caller uses the new token only after the
  // enclosing transaction COMMITs. What no ordering covers: the process dying
  // between the provider's answer and the COMMIT, and the 30 s bound firing
  // after the provider processed the request. If both writes fail and the
  // provider rotated, the stored refresh token is void: the credential is
  // recorded `needs_reauth` (rotation_lost), never shown working on a dead
  // token. If the provider did not rotate, the stored refresh token stays
  // valid: the new access token is handed back and the next use refreshes.
  const store = async (w: Db): Promise<void> => {
    await w
      .update(credentials)
      .set({ payload: updatedEncrypted, updatedAt: new Date() })
      .where(eq(credentials.id, credentialId));
    await recordConnectionState(w, credentialRef(credentialId), {
      state: 'working',
      cause: 'succeeded',
      detail: null,
      observedAt: new Date(),
      retryAfter: null,
    });
  };
  let stored = false;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2 && !stored; attempt++) {
    try {
      await dbOrTx.transaction(store);
      stored = true;
    } catch (err) {
      lastError = err;
      console.error(
        `[refreshAndPersistCredential] storing the token response of credential ${credentialId} ` +
          `failed (attempt ${attempt}/2): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!stored && newRefreshToken !== null) {
    throw new RefreshFailure(
      connectionState(
        'needs_reauth',
        'rotation_lost',
        lastError instanceof Error ? lastError.message : String(lastError),
      ),
      `refreshAndPersistCredential: the rotated refresh token of credential ${credentialId} could not be stored`,
    );
  }

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
 * Fetch + decrypt a credential by id, refreshing the access token if it is
 * past or near the 60 s expiry threshold. This is the USE-time read: the
 * runner calls it when a connector tool is about to reach its provider, never
 * at job start (a job that calls no service makes no token request).
 *
 * NO ownership check: the caller is responsible for access control (the
 * runner trusts the credential_id from agent_connector_assignments).
 *
 * The credential's state (connection_states) is written here, where it is
 * learnt: `working` after a refresh, `needs_reauth` when the token endpoint
 * refuses the grant, `unreachable` when it cannot be reached, `broken` when
 * the payload cannot be decrypted. A grant the provider ended is not retried:
 * while the stored state forbids an attempt (`attemptDue`), no request is
 * sent. The next attempt follows the person authorising again or pressing
 * "Refresh now" (`refreshAndPersistCredential`), which always tries; an
 * unreachable provider is tried again after the stored `retryAfter`.
 *
 * A credential that cannot give a valid token throws
 * `ConnectionUnavailableError` with its state: never a stale token handed on
 * as if it worked. An access token that has not expired yet is a valid one,
 * and is returned even when its early refresh could not be made.
 */
export async function getDecryptedCredentialById(
  db: Db,
  credentialId: string,
): Promise<DecryptedCredential | null> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, credentialId));
  if (!row) return null;
  const ref = credentialRef(credentialId);

  let payload: OauthPayload;
  try {
    payload = decryptPayload(row.payload);
  } catch (err) {
    // Derived again at every read, so a restored master key is enough to
    // bring it back: no stored state to clear.
    throw new ConnectionUnavailableError(
      ref,
      connectionState('broken', 'undecryptable', err instanceof Error ? err.message : String(err)),
    );
  }
  const credentialType = row.type as CredentialType;
  const result = (p: OauthPayload): DecryptedCredential => ({
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    type: credentialType,
    payload: p,
  });

  if (!isPayloadExpiringSoon(payload)) return result(payload);

  const stored = await readConnectionState(db, ref);
  if (!attemptDue(stored)) {
    if (isAccessTokenStillValid(payload)) return result(payload);
    throw new ConnectionUnavailableError(ref, stored);
  }

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
    const connection = refreshFailureState(err);
    console.warn(
      `[getDecryptedCredentialById] refresh of credential ${credentialId} failed ` +
        `(${connection.state}: ${connection.cause}): ${err instanceof Error ? err.message : String(err)}`,
    );
    await recordRefreshOutcome(db, credentialId, connection);
    if (connection.state === 'unreachable' && isAccessTokenStillValid(payload)) {
      return result(payload);
    }
    throw new ConnectionUnavailableError(ref, connection);
  }

  return result(payload);
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
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${credentialId}))`);

      const [row] = await tx.select().from(credentials).where(eq(credentials.id, credentialId));
      if (!row) {
        throw new Error(`refreshAndPersistCredential: credential '${credentialId}' not found`);
      }

      let payload: OauthPayload;
      try {
        payload = decryptPayload(row.payload);
      } catch (err) {
        throw new ConnectionUnavailableError(
          credentialRef(credentialId),
          connectionState(
            'broken',
            'undecryptable',
            err instanceof Error ? err.message : String(err),
          ),
        );
      }
      return doRefresh(tx, credentialId, row, payload);
    });
  } catch (err) {
    if (err instanceof ConnectionUnavailableError) throw err;
    if (!(err instanceof RefreshFailure)) throw err;
    // The person's "Refresh now" is an attempt like any other: what the
    // provider answered becomes the credential's state, and the caller gets
    // the state, typed, to say it in its own words (B50-16).
    await recordRefreshOutcome(db, credentialId, err.connection);
    throw new ConnectionUnavailableError(credentialRef(credentialId), err.connection);
  }
}
