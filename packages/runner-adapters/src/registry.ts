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

import { createNotionTools, NOTION_OPERATIONS } from '@nodal-agents/adapter-notion';
import { createAirtableTools, AIRTABLE_OPERATIONS } from '@nodal-agents/adapter-airtable';
import { createDriveTools, DRIVE_OPERATIONS } from '@nodal-agents/adapter-google-drive';
import { createGmailTools, GMAIL_OPERATIONS } from '@nodal-agents/adapter-gmail';
import {
  createGoogleCalendarTools,
  GOOGLE_CALENDAR_OPERATIONS,
} from '@nodal-agents/adapter-google-calendar';
import { createSheetsTools, SHEETS_OPERATIONS } from '@nodal-agents/adapter-google-sheets';
import { createDocsTools, DOCS_OPERATIONS } from '@nodal-agents/adapter-google-docs';
import { createFirecrawlTools, FIRECRAWL_OPERATIONS } from '@nodal-agents/adapter-firecrawl';
import { createApifyTools, APIFY_OPERATIONS } from '@nodal-agents/adapter-apify';
import { createTavilyTools, TAVILY_OPERATIONS } from '@nodal-agents/adapter-tavily';
import { createPoyoTools, POYO_OPERATIONS } from '@nodal-agents/adapter-poyo';
import type { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { CredentialType, OperationDescriptor } from '@nodal-agents/shared';

export type AdapterCredentialSource = CredentialType | 'api_key';

export type AdapterEntry = {
  credentialType: AdapterCredentialSource;
  toolFactory: (accessToken: string) => ToolDefinition<z.ZodTypeAny, unknown>[];
  /**
   * Present only for adapters whose OAuth access token can expire mid-job —
   * currently the 5 Google adapters (~1h token TTL) and airtable-oauth
   * (~60min token TTL), vs jobs that can run for hours (IDLE_RESET is 4h).
   * When set, the runner calls this INSTEAD of toolFactory, passing a
   * resolver that re-reads (and, via the existing advisory-lock refresh path
   * in getDecryptedCredentialById, refreshes) the credential from the DB
   * before every network call, instead of the one-shot accessToken captured
   * once at job setup (audit#2 M-12). toolFactory remains the contract for
   * callers that only need the tool list/shape with a fixed or mock token
   * (tests, the UI operations grid). Adapters without a refreshable OAuth
   * token (notion-oauth — long-lived, no refresh; all api_key entries —
   * static PAT/API key) leave this undefined and use toolFactory unchanged.
   */
  toolFactoryWithResolver?: (
    getAccessToken: () => Promise<string>,
  ) => ToolDefinition<z.ZodTypeAny, unknown>[];
  operations: OperationDescriptor[];
};

export const ADAPTER_REGISTRY: Record<string, AdapterEntry> = {
  'google-drive': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createDriveTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    toolFactoryWithResolver: (getAccessToken) =>
      createDriveTools({ getAccessToken }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: DRIVE_OPERATIONS,
  },
  gmail: {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createGmailTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    toolFactoryWithResolver: (getAccessToken) =>
      createGmailTools({ getAccessToken }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: GMAIL_OPERATIONS,
  },
  'google-calendar': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createGoogleCalendarTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    toolFactoryWithResolver: (getAccessToken) =>
      createGoogleCalendarTools({ getAccessToken }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: GOOGLE_CALENDAR_OPERATIONS,
  },
  'google-sheets': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createSheetsTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    toolFactoryWithResolver: (getAccessToken) =>
      createSheetsTools({ getAccessToken }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: SHEETS_OPERATIONS,
  },
  'google-docs': {
    credentialType: 'google-oauth',
    toolFactory: (t) =>
      createDocsTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    toolFactoryWithResolver: (getAccessToken) =>
      createDocsTools({ getAccessToken }) as ToolDefinition<z.ZodTypeAny, unknown>[],
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
  // Airtable OAuth2 tokens live ~60min, same class of bug as the 5 Google
  // adapters (audit#2 M-12) — toolFactoryWithResolver re-reads/refreshes the
  // credential before every request instead of a one-shot token.
  'airtable-oauth': {
    credentialType: 'airtable-oauth',
    toolFactory: (t) =>
      createAirtableTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    toolFactoryWithResolver: (getAccessToken) =>
      createAirtableTools({ getAccessToken }) as ToolDefinition<z.ZodTypeAny, unknown>[],
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
  poyo: {
    credentialType: 'api_key',
    toolFactory: (t) =>
      createPoyoTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: POYO_OPERATIONS,
  },
};
