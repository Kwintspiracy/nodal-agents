// connector-catalog.ts — pure-data module (no "use server"): adapter catalog
// surfaced by the connectors UI. Lives outside actions.ts because Next.js 16
// forbids non-async exports from "use server" files.

export const CONNECTOR_AUTH_TYPES = ['api_key', 'oauth2', 'bearer', 'basic', 'none'] as const;

export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/**
 * credentialType links an OAuth2 connector slot to the `credentials` table
 * type that backs it. Multiple connector slugs can share a single credential
 * (e.g. google-drive + gmail + google-sheets + google-docs all use google-oauth).
 * api_key connectors leave this undefined.
 */
export type CredentialType = 'google-oauth' | 'notion-oauth' | 'airtable-oauth';

export type CatalogEntry = {
  slug: string;
  label: string;
  authType: ConnectorAuthType;
  docsHint: string;
  /** Only set for authType === 'oauth2'. */
  credentialType?: CredentialType;
};

/**
 * Catalog of adapter slugs the runner knows about. UI surfaces these so the
 * user picks from a list instead of typing a slug that no adapter listens to.
 * Order matters: we render them in this order on the page.
 */
export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    slug: 'notion',
    label: 'Notion',
    authType: 'api_key',
    docsHint:
      'Create a Notion integration at notion.so/my-integrations and copy its internal secret.',
  },
  {
    slug: 'notion-oauth',
    label: 'Notion (OAuth)',
    authType: 'oauth2',
    credentialType: 'notion-oauth',
    docsHint:
      'Public Integration via OAuth — create one at notion.so/my-integrations (Public type) and authorize from your dashboard.',
  },
  {
    slug: 'google-drive',
    label: 'Google Drive',
    authType: 'oauth2',
    credentialType: 'google-oauth',
    docsHint: 'OAuth flow — uses your Google credential (create one under Credentials).',
  },
  {
    slug: 'gmail',
    label: 'Gmail',
    authType: 'oauth2',
    credentialType: 'google-oauth',
    docsHint: 'OAuth flow — uses your Google credential (create one under Credentials).',
  },
  {
    slug: 'google-sheets',
    label: 'Google Sheets',
    authType: 'oauth2',
    credentialType: 'google-oauth',
    docsHint: 'OAuth flow — uses your Google credential (create one under Credentials).',
  },
  {
    slug: 'google-docs',
    label: 'Google Docs',
    authType: 'oauth2',
    credentialType: 'google-oauth',
    docsHint: 'OAuth flow — uses your Google credential (create one under Credentials).',
  },
  {
    slug: 'airtable-oauth',
    label: 'Airtable (OAuth)',
    authType: 'oauth2',
    credentialType: 'airtable-oauth',
    docsHint: 'OAuth flow for Airtable Public Integrations (recommended).',
  },
  {
    slug: 'airtable',
    label: 'Airtable',
    authType: 'api_key',
    docsHint: 'Personal Access Token — airtable.com/create/tokens.',
  },
  {
    slug: 'apify',
    label: 'Apify',
    authType: 'api_key',
    docsHint: 'Token API Apify — console.apify.com/account/integrations.',
  },
  {
    slug: 'firecrawl',
    label: 'Firecrawl',
    authType: 'api_key',
    docsHint: 'API key Firecrawl — firecrawl.dev/account.',
  },
  {
    slug: 'tavily',
    label: 'Tavily',
    authType: 'api_key',
    docsHint: 'API key Tavily — app.tavily.com.',
  },
];
