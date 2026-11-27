// connector-access.ts — the dashboard's side of "what may this connector do
// with this credential". The answer itself comes from `connectorAccessFor`
// (runner-adapters), the function the runner applies to a job's tool list:
// the card, the binding actions and the operations grid read the same grant
// through the same rule, so the screen says what the engine applies.

import 'server-only';
import { decryptCredentialForDisplay, type AnyDrizzleDb } from '@nodal-agents/db';
import { bindingRefusal, parseScopes, type CredentialType } from '@nodal-agents/shared';
import { connectorAccessFor } from '@nodal-agents/runner-adapters';
import { CONNECTOR_CATALOG } from './connector-catalog.ts';
import type { CompatibleCredential } from './connector-access-types.ts';
import type { CredentialListItem } from './credentials.ts';

/** The catalog fields this module reads (the shape of `ConnectorCatalogItem`). */
type CatalogEntryShape = {
  slug: string;
  authType: string;
  credentialType: CredentialType | null;
};

/**
 * The scopes the provider granted to a credential, as stored by the OAuth
 * callback. Throws when the credential is gone: the caller checked it exists.
 */
export async function readCredentialGrant(
  db: AnyDrizzleDb,
  credentialId: string,
): Promise<string[]> {
  const credential = await decryptCredentialForDisplay(db, credentialId);
  if (!credential) throw new Error(`readCredentialGrant: credential ${credentialId} not found`);
  return parseScopes(credential.payload.scopes);
}

/**
 * Why a credential cannot be bound to connector `slug`, in words for the
 * person, or null when it can. Named scopes are the provider's own, so the
 * person can match them with the provider's consent screen.
 */
export function bindingRefusalFor(slug: string, granted: readonly string[]): string | null {
  const refusal = bindingRefusal(connectorAccessFor(slug, granted));
  if (!refusal) return null;
  const label = CONNECTOR_CATALOG.find((c) => c.slug === slug)?.label ?? slug;
  return (
    `This credential has not been granted access to ${label}. ` +
    `Missing: ${refusal.missingScopes.join(', ')}. Use "Add access" to ask for it.`
  );
}

/**
 * For every OAuth connector of the catalog, the credentials of its type and
 * what each one grants THAT connector: one Google credential can be ready for
 * Drive and lack Gmail's rights, so the lists are per connector, not per type.
 */
export function compatibleCredentialsBySlug(
  catalog: readonly CatalogEntryShape[],
  credentialList: readonly CredentialListItem[],
): Record<string, CompatibleCredential[]> {
  const bySlug: Record<string, CompatibleCredential[]> = {};
  for (const entry of catalog) {
    if (entry.authType !== 'oauth2' || !entry.credentialType) continue;
    bySlug[entry.slug] = credentialList
      .filter((c) => c.type === entry.credentialType)
      .map((c) => ({
        id: c.id,
        name: c.name,
        accountName: c.accountName,
        type: c.type,
        access: c.scopes === null ? null : connectorAccessFor(entry.slug, c.scopes),
      }));
  }
  return bySlug;
}
