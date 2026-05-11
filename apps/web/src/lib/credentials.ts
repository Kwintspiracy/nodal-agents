'use server';

// credentials.ts — server actions + internal helpers for credential lifecycle.
// Server actions (listCredentialsAction, deleteCredentialAction, etc.) never return
// the decrypted payload. Internal helpers (getDecryptedCredential, persist*,
// refresh*) are server-only and return plaintext in memory.
//
// Decryption + token-refresh logic lives in @nodalai/db (packages/db/src/queries/credentials.ts)
// so the runner can also import it without pulling in Next.js. This file adds:
// - Ownership checks via getSession()
// - revalidatePath() calls for Next.js cache invalidation
// - 'use server' / 'server-only' directives

import 'server-only';
import { revalidatePath } from 'next/cache';
import { eq } from '@nodalai/db';
import { credentials, connectors } from '@nodalai/db';
import { getDecryptedCredentialById, refreshAndPersistCredential } from '@nodalai/db';
import { encrypt, isEncrypted } from '@nodalai/secrets';
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

// Re-export DecryptedCredential so existing consumers don't need to change imports.
export type { DecryptedCredential } from '@nodalai/db';

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
          // Use getDecryptedCredentialById to avoid duplicating decrypt logic
          const decrypted = await getDecryptedCredentialById(db, row.id);
          if (decrypted) {
            accountName = decrypted.payload.accountName ?? null;
            expiresAt = decrypted.payload.expiresAt ? new Date(decrypted.payload.expiresAt) : null;
            scopes = decrypted.payload.scopes ?? null;
          }
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

    const { expiresAt } = await refreshAndPersistCredential(db, id);
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

/**
 * Fetch and decrypt a credential row.
 * NO ownership check — callers are responsible for access control.
 * Thin wrapper over getDecryptedCredentialById (from @nodalai/db) that uses
 * the web app's singleton DB instance.
 *
 * Auto-refresh: transparent (handled by getDecryptedCredentialById).
 */
export async function getDecryptedCredential(id: string) {
  return getDecryptedCredentialById(getDb(), id);
}

/**
 * Thin wrapper over refreshAndPersistCredential (from @nodalai/db) that uses
 * the web app's singleton DB instance.
 * Kept for backwards compatibility with existing web app consumers (OAuth callback, tests).
 */
export async function refreshCredentialAccessToken(credentialId: string): Promise<{
  accessToken: string;
  expiresAt: Date | null;
}> {
  return refreshAndPersistCredential(getDb(), credentialId);
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
