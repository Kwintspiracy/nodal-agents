'use server';

// credentials.ts — Server Actions for credential lifecycle (client-facing RPC).
// Every export of this module is registered by Next.js as a network-reachable
// Server Action, whether or not a client component references it — so this
// file MUST only contain actions that (a) enforce ownership via getSession()
// and (b) never return a decrypted payload to the client.
//
// É-1 (audit#2 remediation): the functions that DO decrypt+return OAuth
// payloads (getDecryptedCredential — dead code, removed; refreshCredentialAccessToken;
// persistCredentialFromOauthFlow) were moved OUT of this file into
// credentials-internal.ts, which has no 'use server' directive, so they are
// plain server-only functions again — not RPC endpoints — even though the
// OAuth callback route still calls them exactly as before.
//
// Decryption + token-refresh logic lives in @nodal-agents/db (packages/db/src/queries/credentials.ts)
// so the runner can also import it without pulling in Next.js.

import 'server-only';
import { revalidatePath } from 'next/cache';
import { eq } from '@nodal-agents/db';
import { credentials, connectors } from '@nodal-agents/db';
import {
  decryptCredentialForDisplay,
  readConnectionStates,
  refreshAndPersistCredential,
} from '@nodal-agents/db';
import { z } from 'zod';
import type { CredentialType } from '@nodal-agents/shared';
import {
  ConnectionUnavailableError,
  NOT_CHECKED,
  connectionKey,
  type ConnectionState,
} from '@nodal-agents/shared';
import { connectionReason } from './connection-status.ts';
import { getDb, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

// Re-export DecryptedCredential so existing consumers don't need to change imports.
export type { DecryptedCredential } from '@nodal-agents/db';

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
  /**
   * Surfaces a decryption-level problem to the UI. The list path doesn't
   * trigger a token refresh, so this only catches "ciphertext unreadable"
   * (e.g. master key rotated, payload tampered). Refresh-level failures
   * surface only when the runner tries to use the credential.
   */
  decryptError: string | null;
  /**
   * The credential's connection state: what the last refresh or call learnt
   * (connection_states), or `broken` when this installation cannot decrypt
   * it. The same state a job reads before giving its connectors.
   */
  connection: ConnectionState;
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
    const stored = await readConnectionStates(
      db,
      filtered.map((r) => ({ kind: 'credential' as const, id: r.id })),
    );

    const items: CredentialListItem[] = await Promise.all(
      filtered.map(async (row) => {
        // Decrypt to read display-only fields. The list path is read-only —
        // it must NOT trigger an OAuth refresh roundtrip (that would hit the
        // provider every time a user opens /credentials, masking real state).
        // Refresh happens at use-time via getDecryptedCredentialById in the runner.
        let accountName: string | null = null;
        let expiresAt: Date | null = null;
        let scopes: string | null = null;
        let decryptError: string | null = null;
        try {
          const decrypted = await decryptCredentialForDisplay(db, row.id);
          if (decrypted) {
            accountName = decrypted.payload.accountName ?? null;
            expiresAt = decrypted.payload.expiresAt ? new Date(decrypted.payload.expiresAt) : null;
            scopes = decrypted.payload.scopes ?? null;
          }
        } catch (err) {
          decryptError = err instanceof Error ? err.message : 'decrypt_failed';
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
          decryptError,
          connection:
            decryptError !== null
              ? {
                  state: 'broken',
                  cause: 'undecryptable',
                  detail: null,
                  observedAt: null,
                  retryAfter: null,
                }
              : (stored.get(connectionKey({ kind: 'credential', id: row.id })) ?? NOT_CHECKED),
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
    if (!z.string().guid().safeParse(id).success) {
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
    if (!z.string().guid().safeParse(id).success) {
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
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid credential id');
    }
    const db = getDb();

    const [existing] = await db
      .select({ id: credentials.id, ownerUserId: credentials.ownerUserId })
      .from(credentials)
      .where(eq(credentials.id, id));

    if (!existing) return fail('not_found', 'Credential not found');
    if (existing.ownerUserId !== session.userId) return fail('forbidden', 'Access denied');

    const { expiresAt } = await refreshAndPersistCredential(db, id);
    revalidatePath('/credentials');
    revalidatePath('/connectors');
    return ok({ expiresAt });
  } catch (err) {
    console.error('[refreshCredentialAction]', err);
    // The refresh records what the provider answered as the credential's
    // state and throws it typed: the person reads the state's words, never
    // the provider's raw body (B50-16). The screens re-read the state.
    if (err instanceof ConnectionUnavailableError) {
      revalidatePath('/credentials');
      revalidatePath('/connectors');
      return fail(
        `connection_${err.connection.state}`,
        connectionReason(err.connection) ?? 'Token refresh failed.',
      );
    }
    return fail('refresh_failed', 'Token refresh failed. See the server log for the cause.');
  }
}
