// connector-catalog.ts — re-export of the shared connector catalog.
//
// The catalog data now lives in @nodal-agents/shared (single source of truth,
// so the ROOT `create_connector` meta-tool in packages/tools validates against
// the same list as this dashboard UI). This module stays as the stable import
// path for the connectors UI + actions. Pure-data re-export (no "use server"):
// Next.js 16 forbids non-async exports from "use server" files.

export {
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_CATALOG,
  type ConnectorAuthType,
  type CredentialType,
  type CatalogEntry,
} from '@nodal-agents/shared';
