// connector-catalog.ts — pure-data module (no "use server"): adapter catalog
// surfaced by the connectors UI. Lives outside actions.ts because Next.js 16
// forbids non-async exports from "use server" files.

export const CONNECTOR_AUTH_TYPES = ['api_key', 'oauth2', 'bearer', 'basic', 'none'] as const;

export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/**
 * Catalog of adapter slugs the runner knows about. UI surfaces these so the
 * user picks from a list instead of typing a slug that no adapter listens to.
 * Order matters: we render them in this order on the page.
 */
export const CONNECTOR_CATALOG = [
  {
    slug: 'notion',
    label: 'Notion',
    authType: 'api_key' as ConnectorAuthType,
    docsHint:
      'Create a Notion integration at notion.so/my-integrations and copy its internal secret.',
  },
  {
    slug: 'notion-oauth',
    label: 'Notion (OAuth)',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint:
      'Public Integration via OAuth — create one at notion.so/my-integrations (Public type) and authorize from your dashboard.',
  },
  {
    slug: 'google-drive',
    label: 'Google Drive',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint:
      'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
  {
    slug: 'gmail',
    label: 'Gmail',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint:
      'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
  {
    slug: 'google-sheets',
    label: 'Google Sheets',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint:
      'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
  {
    slug: 'google-docs',
    label: 'Google Docs',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint:
      'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
] as const;
