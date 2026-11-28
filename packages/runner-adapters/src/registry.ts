// ADAPTER_REGISTRY — maps connector slug → { credentialType, toolFactory, operations }.
// Used by both the runner (to instantiate tools per job) and the web UI
// (to display the operations grid in AgentForm before an access token is resolved).
//
// Every connector tool a job receives comes out of a factory of this registry,
// and the registry gives it its risk and its default approval from the
// operation descriptor (issue #735, `bindOperationDescriptors`). An adapter
// builds tools without either: the descriptor the Connectors and Approvals
// tabs show is the one the approval gate reads.
//
// `credentialType` tells the runner where to find the bearer token for the
// connector at job-execution time:
//   - one of CredentialType (e.g. 'google-oauth', 'notion-oauth', 'airtable-oauth')
//     → token comes from credentials.payload.accessToken via the credentialId FK
//   - 'api_key' → token is the decrypted connectors.api_key column (no
//     credentials row); used by Personal Access Tokens and API keys
//     (firecrawl, apify, tavily, airtable PAT, notion internal integration).

import { createNotionTools, NOTION_OPERATIONS } from '@nodal-agents/adapter-notion';
import {
  createOutlookMailTools,
  OUTLOOK_MAIL_OPERATIONS,
} from '@nodal-agents/adapter-outlook-mail';
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
import { createCloudflareTools, CLOUDFLARE_OPERATIONS } from '@nodal-agents/adapter-cloudflare';
import { createApifyTools, APIFY_OPERATIONS } from '@nodal-agents/adapter-apify';
import { createTavilyTools, TAVILY_OPERATIONS } from '@nodal-agents/adapter-tavily';
import { createPoyoTools, POYO_OPERATIONS } from '@nodal-agents/adapter-poyo';
import type { z } from 'zod';
import type { ConnectorIo, ConnectorToolDefinition, ToolDefinition } from '@nodal-agents/tools';
import type { CredentialType, OperationDescriptor } from '@nodal-agents/shared';
import {
  contractTransport,
  holdToContract,
  type ContractOptions,
} from './connector-contract-layer';

export type AdapterCredentialSource = CredentialType | 'api_key';

export type AdapterEntry = {
  credentialType: AdapterCredentialSource;
  /**
   * The adapter's tools, each held to the connector contract
   * (connector-contract-layer.ts). `options` is for tests: a fake provider as
   * `fetch`, a short bound. The runner passes none.
   */
  toolFactory: (
    accessToken: string,
    options?: ContractOptions,
  ) => ToolDefinition<z.ZodTypeAny, unknown>[];
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
    options?: ContractOptions,
  ) => ToolDefinition<z.ZodTypeAny, unknown>[];
  operations: OperationDescriptor[];
};

type ConnectorTool = ConnectorToolDefinition<z.ZodTypeAny, unknown>;

/**
 * An adapter as written: its factories build tools without risk or approval,
 * over the transport `io` gives them.
 */
type ConnectorSource = {
  credentialType: AdapterCredentialSource;
  toolFactory: (accessToken: string, io: ConnectorIo) => ConnectorTool[];
  toolFactoryWithResolver?: (
    getAccessToken: () => Promise<string>,
    io: ConnectorIo,
  ) => ConnectorTool[];
  operations: OperationDescriptor[];
  /**
   * The factory hands `io.fetch` to its provider's SDK, so every request of
   * a call goes through the contract's transport. Absent: the adapter's SDK
   * takes no such transport yet (contract-ratchet.ts says which, and what each
   * needs); the bound, the stop and the error's class still hold, from the
   * call itself.
   */
  passesTransport?: true;
};

/**
 * Give each tool of a connector the risk and the default approval its
 * operation descriptor declares (issue #735): `risk` becomes `riskLevel`, and
 * `requiresApproval: true` becomes `defaultApproval: 'require_approval'`, which
 * the approval gate (`executeTool`) applies when no rule names the tool.
 *
 * A tool without a descriptor, or a descriptor without a tool, throws: the
 * first would reach the gate with a risk nobody declared, the second would
 * show the owner an operation the agent cannot call. Neither gets a default.
 */
export function bindOperationDescriptors(
  slug: string,
  operations: readonly OperationDescriptor[],
  tools: readonly ConnectorTool[],
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const bySlug = new Map(operations.map((op) => [op.slug, op]));
  const bound = tools.map((tool): ToolDefinition<z.ZodTypeAny, unknown> => {
    const op = bySlug.get(tool.name);
    if (!op) {
      throw new Error(
        `connector '${slug}': tool '${tool.name}' has no operation descriptor, ` +
          'so its risk and default approval are unknown. Declare it in the adapter operations.',
      );
    }
    return op.requiresApproval
      ? { ...tool, riskLevel: op.risk, defaultApproval: 'require_approval' }
      : { ...tool, riskLevel: op.risk };
  });
  const built = new Set(tools.map((t) => t.name));
  const orphans = operations.filter((op) => !built.has(op.slug)).map((op) => op.slug);
  if (orphans.length > 0) {
    throw new Error(
      `connector '${slug}': operation descriptor(s) ${orphans.join(', ')} match no tool ` +
        'its factory builds. Remove them or build the tool.',
    );
  }
  return bound;
}

/**
 * Every tool of a connector, as a job receives it: its descriptor's risk and
 * approval (`bindOperationDescriptors`), then held to the connector contract
 * (`holdToContract`), every request of every call through one transport.
 */
function bindSource(slug: string, source: ConnectorSource): AdapterEntry {
  const { toolFactory, toolFactoryWithResolver, operations } = source;
  const contract = { passesTransport: source.passesTransport === true };
  const bySlug = new Map(operations.map((op) => [op.slug, op]));
  const hold = (tools: ConnectorTool[], options: ContractOptions = {}) =>
    bindOperationDescriptors(slug, operations, tools).map((tool) =>
      holdToContract(tool, bySlug.get(tool.name)!, contract, options),
    );
  const ioFor = (options: ContractOptions = {}): ConnectorIo => ({
    // Read at each request, so the process's fetch is the one current then.
    fetch: contractTransport(() => options.fetch ?? globalThis.fetch),
  });
  return {
    credentialType: source.credentialType,
    toolFactory: (accessToken, options) => hold(toolFactory(accessToken, ioFor(options)), options),
    ...(toolFactoryWithResolver
      ? {
          toolFactoryWithResolver: (
            getAccessToken: () => Promise<string>,
            options?: ContractOptions,
          ) => hold(toolFactoryWithResolver(getAccessToken, ioFor(options)), options),
        }
      : {}),
    operations,
  };
}

const CONNECTOR_SOURCES: Record<string, ConnectorSource> = {
  'google-drive': {
    credentialType: 'google-oauth',
    toolFactory: (t, io) => createDriveTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createDriveTools({ getAccessToken, fetch: io.fetch }),
    operations: DRIVE_OPERATIONS,
    passesTransport: true,
  },
  gmail: {
    credentialType: 'google-oauth',
    toolFactory: (t, io) => createGmailTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createGmailTools({ getAccessToken, fetch: io.fetch }),
    operations: GMAIL_OPERATIONS,
    passesTransport: true,
  },
  'google-calendar': {
    credentialType: 'google-oauth',
    toolFactory: (t, io) => createGoogleCalendarTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createGoogleCalendarTools({ getAccessToken, fetch: io.fetch }),
    operations: GOOGLE_CALENDAR_OPERATIONS,
    passesTransport: true,
  },
  'google-sheets': {
    credentialType: 'google-oauth',
    toolFactory: (t, io) => createSheetsTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createSheetsTools({ getAccessToken, fetch: io.fetch }),
    operations: SHEETS_OPERATIONS,
    passesTransport: true,
  },
  'google-docs': {
    credentialType: 'google-oauth',
    toolFactory: (t, io) => createDocsTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createDocsTools({ getAccessToken, fetch: io.fetch }),
    operations: DOCS_OPERATIONS,
    passesTransport: true,
  },
  // notion-oauth: Public Integration (browser OAuth roundtrip)
  'notion-oauth': {
    credentialType: 'notion-oauth',
    toolFactory: (t, io) => createNotionTools({ accessToken: t, fetch: io.fetch }),
    operations: NOTION_OPERATIONS,
    passesTransport: true,
  },
  // notion: Internal Integration api_key — wire format identical on the Notion API.
  // Token is the decrypted connectors.api_key (no credentials row).
  notion: {
    credentialType: 'api_key',
    toolFactory: (t, io) => createNotionTools({ accessToken: t, fetch: io.fetch }),
    operations: NOTION_OPERATIONS,
    passesTransport: true,
  },
  // outlook-mail: Microsoft Graph delegated OAuth access token via
  // credentials.payload.accessToken. Microsoft access tokens live ~60-90min
  // (same class as the Google adapters / airtable-oauth — audit#2 M-12) —
  // toolFactoryWithResolver re-reads/refreshes the credential before every
  // Graph request instead of a one-shot token.
  'outlook-mail': {
    credentialType: 'microsoft-oauth',
    toolFactory: (t, io) => createOutlookMailTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createOutlookMailTools({ getAccessToken, fetch: io.fetch }),
    operations: OUTLOOK_MAIL_OPERATIONS,
    passesTransport: true,
  },
  // airtable-oauth: OAuth access token via credentials.payload.accessToken.
  // Airtable OAuth2 tokens live ~60min, same class of bug as the 5 Google
  // adapters (audit#2 M-12) — toolFactoryWithResolver re-reads/refreshes the
  // credential before every request instead of a one-shot token.
  'airtable-oauth': {
    credentialType: 'airtable-oauth',
    toolFactory: (t, io) => createAirtableTools({ accessToken: t, fetch: io.fetch }),
    toolFactoryWithResolver: (getAccessToken, io) =>
      createAirtableTools({ getAccessToken, fetch: io.fetch }),
    operations: AIRTABLE_OPERATIONS,
    passesTransport: true,
  },
  // airtable: Personal Access Token via connectors.api_key. Same Bearer wire
  // format as the OAuth path — the adapter doesn't distinguish.
  airtable: {
    credentialType: 'api_key',
    toolFactory: (t, io) => createAirtableTools({ accessToken: t, fetch: io.fetch }),
    operations: AIRTABLE_OPERATIONS,
    passesTransport: true,
  },
  firecrawl: {
    credentialType: 'api_key',
    toolFactory: (t) => createFirecrawlTools({ accessToken: t }),
    operations: FIRECRAWL_OPERATIONS,
  },
  // cloudflare: API Token (template « Edit Cloudflare Workers ») via
  // connectors.api_key. Deploy runs wrangler; list/delete use the official SDK.
  cloudflare: {
    credentialType: 'api_key',
    toolFactory: (t, io) => createCloudflareTools({ accessToken: t, fetch: io.fetch }),
    operations: CLOUDFLARE_OPERATIONS,
    passesTransport: true,
  },
  apify: {
    credentialType: 'api_key',
    toolFactory: (t) => createApifyTools({ accessToken: t }),
    operations: APIFY_OPERATIONS,
  },
  tavily: {
    credentialType: 'api_key',
    toolFactory: (t) => createTavilyTools({ accessToken: t }),
    operations: TAVILY_OPERATIONS,
  },
  poyo: {
    credentialType: 'api_key',
    toolFactory: (t, io) => createPoyoTools({ accessToken: t, fetch: io.fetch }),
    operations: POYO_OPERATIONS,
    passesTransport: true,
  },
};

export const ADAPTER_REGISTRY: Record<string, AdapterEntry> = Object.fromEntries(
  Object.entries(CONNECTOR_SOURCES).map(([slug, source]) => [slug, bindSource(slug, source)]),
);
