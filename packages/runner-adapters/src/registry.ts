// ADAPTER_REGISTRY — maps connector slug → { credentialType, toolFactory, operations }.
// Used by both the runner (to instantiate tools per job) and the web UI
// (to display the operations grid in AgentForm before an access token is resolved).
//
// `credentialType` tells the runner where to find the bearer token for the
// connector at job-execution time:
//   - one of CredentialType (e.g. 'google-oauth', 'notion-oauth', 'airtable-oauth')
//     → token comes from credentials.payload.accessToken via the credentialId FK
//   - 'api_key' → token is the decrypted connectors.api_key column (no
//     credentials row); used by Personal Access Tokens and API keys
//     (firecrawl, apify, tavily, airtable PAT, notion internal integration).

import { createNotionTools, NOTION_OPERATIONS } from '@nodalai/adapter-notion';
import { createAirtableTools, AIRTABLE_OPERATIONS } from '@nodalai/adapter-airtable';
import { createDriveTools, DRIVE_OPERATIONS } from '@nodalai/adapter-google-drive';
import { createGmailTools, GMAIL_OPERATIONS } from '@nodalai/adapter-gmail';
import { createSheetsTools, SHEETS_OPERATIONS } from '@nodalai/adapter-google-sheets';
import { createDocsTools, DOCS_OPERATIONS } from '@nodalai/adapter-google-docs';
import { createFirecrawlTools, FIRECRAWL_OPERATIONS } from '@nodalai/adapter-firecrawl';
import { createApifyTools, APIFY_OPERATIONS } from '@nodalai/adapter-apify';
import { createTavilyTools, TAVILY_OPERATIONS } from '@nodalai/adapter-tavily';
import type { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { CredentialType, OperationDescriptor } from '@nodalai/shared';

export type AdapterCredentialSource = CredentialType | 'api_key';

export type AdapterEntry = {
  credentialType: AdapterCredentialSource;
  toolFactory: (accessToken: string) => ToolDefinition<z.ZodTypeAny, unknown>[];
  operations: OperationDescriptor[];
};

export const ADAPTER_REGISTRY: Record<string, AdapterEntry> = {
  'google-drive': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createDriveTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: DRIVE_OPERATIONS,
  },
  gmail: {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createGmailTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: GMAIL_OPERATIONS,
  },
  'google-sheets': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createSheetsTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: SHEETS_OPERATIONS,
  },
  'google-docs': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createDocsTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: DOCS_OPERATIONS,
  },
  // notion-oauth: Public Integration (browser OAuth roundtrip)
  'notion-oauth': {
    credentialType: 'notion-oauth',
    toolFactory: (t) =>
      createNotionTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: NOTION_OPERATIONS,
  },
  // notion: Internal Integration api_key — wire format identical on the Notion API.
  // Token is the decrypted connectors.api_key (no credentials row).
  notion: {
    credentialType: 'api_key',
    toolFactory: (t) =>
      createNotionTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: NOTION_OPERATIONS,
  },
  // airtable-oauth: OAuth access token via credentials.payload.accessToken.
  'airtable-oauth': {
    credentialType: 'airtable-oauth',
    toolFactory: (t) =>
      createAirtableTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: AIRTABLE_OPERATIONS,
  },
  // airtable: Personal Access Token via connectors.api_key. Same Bearer wire
  // format as the OAuth path — the adapter doesn't distinguish.
  airtable: {
    credentialType: 'api_key',
    toolFactory: (t) =>
      createAirtableTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: AIRTABLE_OPERATIONS,
  },
  firecrawl: {
    credentialType: 'api_key',
    toolFactory: (t) =>
      createFirecrawlTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: FIRECRAWL_OPERATIONS,
  },
  apify: {
    credentialType: 'api_key',
    toolFactory: (t) =>
      createApifyTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: APIFY_OPERATIONS,
  },
  tavily: {
    credentialType: 'api_key',
    toolFactory: (t) =>
      createTavilyTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: TAVILY_OPERATIONS,
  },
};
