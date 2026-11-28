// connector-access-types.ts — the shapes the connectors screens receive from
// the server (no server-only import here: client components read these types).

import type { ConnectorAccess, CredentialType } from '@nodal-agents/shared';

/** A credential that could back a connector, with what it grants that connector. */
export type CompatibleCredential = {
  id: string;
  name: string;
  accountName: string | null;
  type: CredentialType;
  /**
   * What the connector may do under this credential's grant (the rule a job's
   * tool list applies). Null when the grant could not be read.
   */
  access: ConnectorAccess | null;
};
