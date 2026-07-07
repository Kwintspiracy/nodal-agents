// credentials-internal.ts — server-only helpers that return decrypted OAuth
// payloads (access tokens in clear).
//
// É-1 (audit#2 remediation): these functions used to live in credentials.ts,
// which carries a top-level 'use server' directive. Next.js treats EVERY
// exported async function of a 'use server' module as a Server Action — i.e.
// a network-reachable RPC endpoint — regardless of whether any client
// component actually references it. That turned refreshCredentialAccessToken /
// persistCredentialFromOauthFlow into callable endpoints with NO ownership
// check (getDecryptedCredentialById explicitly documents "NO ownership
// check" — callers are trusted to gate access themselves).
//
// This module is deliberately NOT a 'use server' module: it is a plain
// server-only TypeScript file. Its exports remain callable by other server
// code (the OAuth callback route) as ordinary function calls, but Next never
// registers them in the server-actions manifest, so they are unreachable
// from the client RPC mechanism.
import 'server-only';
import { revalidatePath } from 'next/cache';
import { getDb } from './server.ts';
import { refreshAndPersistCredential } from '@nodal-agents/db';
import { credentials } from '@nodal-agents/db';
import { encrypt, isEncrypted } from '@nodal-agents/secrets';
import type {
  CredentialType,
  GoogleOauthPayload,
  NotionOauthPayload,
  AirtableOauthPayload,
} from '@nodal-agents/shared';

export type OauthPayload = GoogleOauthPayload | NotionOauthPayload | AirtableOauthPayload;

/**
 * Thin wrapper over refreshAndPersistCredential (from @nodal-agents/db) that uses
 * the web app's singleton DB instance.
 * Kept for backwards compatibility with existing web app consumers (OAuth callback, tests).
 *
 * NOT a Server Action — see module header. Callers remain responsible for
 * access control before invoking this (the OAuth callback route calls it for
 * the credential it just created/holds; nothing else should call it).
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
 *
 * NOT a Server Action — see module header. Only the OAuth callback route
 * (server-side, post token-exchange) calls this today.
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
