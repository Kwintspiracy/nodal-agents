// ADAPTER_REGISTRY — maps connector slug → { credentialType, toolFactory, operations }.
// Used by both the runner (to instantiate tools per job) and the web UI
// (to display the operations grid in AgentForm before an access token is resolved).
//
// Only adapters with a concrete implementation are listed here.
// Catalog-only connectors (airtable, apify, firecrawl, tavily) are added
// in dedicated briques once their adapter packages ship.

import { createNotionTools, NOTION_OPERATIONS } from '@nodalai/adapter-notion';
import { createDriveTools, DRIVE_OPERATIONS } from '@nodalai/adapter-google-drive';
import { createGmailTools, GMAIL_OPERATIONS } from '@nodalai/adapter-gmail';
import { createSheetsTools, SHEETS_OPERATIONS } from '@nodalai/adapter-google-sheets';
import { createDocsTools, DOCS_OPERATIONS } from '@nodalai/adapter-google-docs';
import type { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { CredentialType, OperationDescriptor } from '@nodalai/shared';

export type AdapterEntry = {
  credentialType: CredentialType;
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
  // notion: Internal Integration api_key — wire format identical on the Notion API
  notion: {
    credentialType: 'notion-oauth',
    toolFactory: (t) =>
      createNotionTools({ accessToken: t }) as ToolDefinition<z.ZodTypeAny, unknown>[],
    operations: NOTION_OPERATIONS,
  },
};
