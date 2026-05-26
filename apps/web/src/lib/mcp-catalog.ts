// mcp-catalog.ts — pure-data module (no "use server"): the curated library of
// MCP connectors surfaced by the /mcp page. The MCP counterpart of
// connector-catalog.ts. Lives outside actions.ts because Next.js 16 forbids
// non-async exports from "use server" files.
//
// Each entry carries everything needed to build the mcp_servers DB row when
// the user connects it. The row is the runtime source of truth — the runner
// never imports this catalog.

/**
 * How an MCP server's API key is injected into the HTTP request.
 * - `header`: `headers[authParamName] = apiKey` (e.g. `x-api-key: <key>`)
 * - `query`: appended to the URL as `?<authParamName>=<apiKey>`
 * - `bearer`: `headers['Authorization'] = 'Bearer ' + apiKey` (authParamName ignored)
 */
export type McpAuthScheme = 'header' | 'query' | 'bearer';

export type McpCatalogEntry = {
  /** Stable id — also the mcp_servers.slug and the tool-name namespace.
   *  Two reserved sentinel slugs (`custom-http-mcp`, `custom-stdio-mcp`)
   *  mark the "Custom" entries — the action layer overrides the catalog
   *  values with user-supplied ones for those. */
  slug: string;
  /** Display name in the /mcp UI. */
  label: string;
  /** One-line description shown on the connector card. */
  description: string;
  /**
   * Streamable HTTP endpoint of the MCP server.
   * `null` = the user supplies the URL at connect time (typical of
   * per-account hosted servers like Composio where the URL embeds a
   * server-id and user-id).
   * Always `null` for stdio entries — meaningless there.
   */
  serverUrl: string | null;
  /**
   * Transport. `'http'` = Streamable HTTP. `'stdio'` = local subprocess
   * spawned by the runner (uses `mcp_servers.command/args/envVars`).
   */
  transport: 'http' | 'stdio';
  /** Where the API key goes. Ignored for stdio (no key — env vars instead). */
  authScheme: McpAuthScheme;
  /**
   * The literal header name or query-param name (e.g. 'x-api-key').
   * Set to a placeholder (e.g. 'Authorization') and ignored when
   * `authScheme === 'bearer'` or `transport === 'stdio'` — kept non-null
   * for type stability.
   */
  authParamName: string;
  /**
   * Accepted API-key prefixes — the create form rejects a candidate key
   * unless it starts with at least one of these. Empty array = no prefix
   * check (use when the provider has no canonical prefix or accepts many
   * formats). Stripe e.g. ships both `sk_…` (secret) and `rk_…`
   * (restricted, recommended for least-privilege) keys, both valid.
   */
  keyPrefix: string[];
  /**
   * Read-only tool called once at connect time to verify the key works.
   * `null` = skip the extra verify call; the underlying `tools/list`
   * (which fails on bad auth) is sufficient. Use for servers whose
   * tool set is user-specific and has no universal probe (Composio,
   * Zapier-like aggregators).
   */
  verifyToolName: string | null;
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
    keyPrefix: ['cog_'],
    verifyToolName: 'get_home',
    docsHint:
      'API key starting with cog_ — created in the Cogni app when a human registers an agent in "I control it" mode.',
  },
  {
    slug: 'stripe',
    label: 'Stripe',
    description:
      'Payment processing — read customers, products, prices, invoices, subscriptions; create coupons, payment links, refunds.',
    serverUrl: 'https://mcp.stripe.com',
    transport: 'http',
    authScheme: 'bearer',
    authParamName: 'Authorization',
    keyPrefix: ['sk_', 'rk_'],
    verifyToolName: 'retrieve_balance',
    docsHint:
      'Use a Restricted API Key (rk_test_… or rk_live_…) from https://dashboard.stripe.com/apikeys for least privilege — recommended. Standard secret keys (sk_test_… or sk_live_…) also work.',
  },
  {
    slug: 'composio',
    label: 'Composio',
    description:
      'Meta-toolkit: a Composio MCP server you provision exposes hundreds of tools across Gmail, Slack, GitHub, Linear, and more — configured per-server on composio.dev.',
    serverUrl: null,
    transport: 'http',
    authScheme: 'header',
    authParamName: 'x-api-key',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Create an MCP server at https://app.composio.dev, paste its full URL here (format: https://backend.composio.dev/v3/mcp/<server-id>?user_id=<user-id>) plus your Composio API key.',
  },
  // ── Custom entries ────────────────────────────────────────────────────────
  // Reserved slugs — the action layer (createMcpServerFromCatalogAction)
  // detects these and substitutes user-supplied values (slug, auth scheme,
  // command, etc.) for the placeholder catalog values below. The persisted
  // mcp_servers.slug ends up being whatever the user typed, NOT the catalog
  // slug; that's what makes tool name prefixes (`<user-slug>__<tool>`)
  // collision-free even when several customs exist.
  {
    slug: 'custom-http-mcp',
    label: 'Custom MCP (HTTP)',
    description:
      'Connect any HTTP-streaming MCP server. You provide the URL, auth, and a short slug for tool naming.',
    serverUrl: null,
    transport: 'http',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Anything that speaks the MCP Streamable HTTP protocol. The "Server slug" you choose becomes the tool name prefix.',
  },
  {
    slug: 'custom-stdio-mcp',
    label: 'Custom MCP (stdio)',
    description:
      'Run a local MCP server as a subprocess. Use this for filesystem, sqlite, github, fetch, and other npm/python MCP packages that expect to be spawned by their host.',
    serverUrl: null,
    transport: 'stdio',
    // The next three fields don't apply to stdio (no HTTP key path) but are
    // kept non-null for type stability — the action layer treats them as
    // ignored when transport === 'stdio'.
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Runs locally with your permissions — only connect MCP servers you trust. Env var values are encrypted at rest.',
  },
];
