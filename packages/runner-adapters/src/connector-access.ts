// connector-access.ts — what a connector may do with a credential's grant,
// read from the operations its adapter ships. The one place the runner (a
// job's tool list) and the dashboard (connector card, binding actions,
// operations grid) ask the question, so both say the same thing.

import {
  NOT_CHECKED,
  connectorAccess,
  getOAuthProvider,
  parseScopes,
  type ConnectionState,
  type ConnectorAccess,
} from '@nodal-agents/shared';
import { ADAPTER_REGISTRY } from './registry';

/**
 * Access of connector `slug` under a grant, given as the provider's
 * space-separated scope string (how a credential stores it) or as a list,
 * on a connection in state `connection` (`connectorConnection`: the
 * credential's and the connector's stored states, and the facts of their
 * rows). Throws for a slug with no adapter: there is no operation list to
 * judge.
 */
export function connectorAccessFor(
  slug: string,
  granted: string | readonly string[] | null | undefined,
  connection: ConnectionState = NOT_CHECKED,
): ConnectorAccess {
  const entry = ADAPTER_REGISTRY[slug];
  if (!entry) {
    throw new Error(`connectorAccessFor: no adapter is registered for connector '${slug}'`);
  }
  const scopes = typeof granted === 'string' || granted == null ? parseScopes(granted) : granted;
  // A key (`api_key`) carries no OAuth grant: the provider decides its rights,
  // and no operation is judged by scopes it was never asked for.
  const operations =
    entry.credentialType === 'api_key'
      ? entry.operations.map(({ scopes: _scopes, ...op }) => op)
      : entry.operations;
  return connectorAccess(operations, scopes, getOAuthProvider(slug)?.grantedScopeForm, connection);
}
