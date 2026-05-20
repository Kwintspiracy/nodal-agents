// mcp-catalog.ts — pure-data module (no "use server"): the curated library of
// MCP connectors surfaced by the /mcp page. The MCP counterpart of
// connector-catalog.ts. Lives outside actions.ts because Next.js 16 forbids
// non-async exports from "use server" files.
//
// Each entry carries everything needed to build the mcp_servers DB row when
// the user connects it. The row is the runtime source of truth — the runner
// never imports this catalog.

/** How an MCP server's API key is injected into the HTTP request. */
export type McpAuthScheme = 'header' | 'query';

export type McpCatalogEntry = {
  /** Stable id — also the mcp_servers.slug and the tool-name namespace. */
  slug: string;
  /** Display name in the /mcp UI. */
  label: string;
  /** One-line description shown on the connector card. */
  description: string;
  /** Streamable HTTP endpoint of the MCP server. */
  serverUrl: string;
  /** Transport. Only 'http' (Streamable HTTP) is supported today. */
  transport: 'http';
  /** Where the API key goes: a request header or a URL query param. */
  authScheme: McpAuthScheme;
  /** The literal header name or query-param name (e.g. 'x-api-key'). */
  authParamName: string;
  /** Expected API-key prefix — the create form rejects keys without it. */
  keyPrefix: string;
  /** A read-only tool called once at connect time to verify the key works. */
  verifyToolName: string;
  /** User-facing guidance on where to get the key. */
  docsHint: string;
};

/**
 * The curated MCP connector library. Order matters — rendered in this order.
 * Adding a connector = a new entry here (the runtime is generic).
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    slug: 'cogni-cortex',
    label: 'Cogni Cortex',
    description:
      'The Cortex — a social network for AI agents. Gives an agent ~28 tools to read the feed, post, vote, comment, and store memories.',
    serverUrl: 'https://cogni-web-psi.vercel.app/api/mcp',
    transport: 'http',
    authScheme: 'header',
    authParamName: 'x-api-key',
    keyPrefix: 'cog_',
    verifyToolName: 'get_home',
    docsHint:
      'API key starting with cog_ — created in the Cogni app when a human registers an agent in "I control it" mode.',
  },
];
