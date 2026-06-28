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
  /**
   * Validation status surfaced as a marketplace badge.
   * - omitted / `'verified'` → connector has been verified end-to-end live.
   * - `'pending'` → shipped but not yet live-verified; the card shows a
   *   "Test pending" badge so the user knows the connection params may
   *   need adjusting. Lets us extend the catalogue without claiming
   *   everything works (honest counterpart to the "no half-baked catalog"
   *   invariant).
   */
  status?: 'verified' | 'pending';
  /**
   * Pre-filled command for stdio catalog entries (non-custom).
   * `undefined` for HTTP entries and the `custom-stdio-mcp` sentinel
   * (user supplies the command for those).
   * Example: `'npx'` for npm-published MCP servers.
   */
  command?: string;
  /**
   * Pre-filled args for stdio catalog entries (non-custom).
   * `undefined` for HTTP entries and `custom-stdio-mcp`.
   * Example: `['-y', '@modelcontextprotocol/server-filesystem', '/path']`.
   * Note: for servers that require path arguments, a placeholder such as
   * `'<root-directory>'` is used — the user edits it before connecting.
   */
  args?: string[];
  /**
   * Env var names the server expects. Shown in the Add form as pre-labelled
   * rows so the user knows exactly what to fill in.
   * `undefined` = no env vars required (e.g. filesystem).
   */
  envVarNames?: string[];
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
  // ── stdio servers ────────────────────────────────────────────────────────
  // These are spawned locally via `npx -y <pkg>` the first time. The runner
  // downloads the package on first use (needs network + adds ~5–30 s latency
  // on the initial connect). Subsequent runs use the npx cache.
  {
    slug: 'mcp-filesystem',
    label: 'Filesystem',
    description:
      'Read and write files on the host machine. Useful for broad disk access outside an agent workspace. First run downloads the package via npx (requires network, ~5 s latency).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Replace <root-directory> in the args with the absolute path of the folder to expose (e.g. /home/user/docs). The server restricts all operations to that tree.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14', '<root-directory>'],
  },
  {
    slug: 'mcp-fetch',
    label: 'Fetch',
    description:
      'Fetch web pages and convert them to clean Markdown or plain text for agents. First run downloads the package via npx (requires network, ~5 s latency).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint: 'No API key required. The server fetches URLs on behalf of the agent.',
    command: 'npx',
    args: ['-y', 'mcp-fetch-server@1.1.2'],
  },
  {
    slug: 'mcp-git',
    label: 'Git',
    description:
      'Run git operations (status, diff, log, commit, branch, etc.) on a local repository. First run downloads the package via npx (requires network, ~5–10 s latency).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Replace <repo-path> in the args with the absolute path to the git repository root (e.g. /home/user/myrepo). No API key required.',
    command: 'npx',
    args: ['-y', '@cyanheads/git-mcp-server@2.15.1', '--repo', '<repo-path>'],
  },
  {
    slug: 'mcp-github',
    label: 'GitHub',
    description:
      'Read and manage GitHub repositories, issues, PRs, and code via a Personal Access Token. First run downloads the package via npx (requires network, ~5 s latency).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Create a GitHub Personal Access Token (PAT) at https://github.com/settings/tokens with the repo scope and paste it as the GITHUB_PERSONAL_ACCESS_TOKEN env var below.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
    envVarNames: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    slug: 'mcp-postgres',
    label: 'PostgreSQL',
    description:
      'Run read-only SQL queries against a PostgreSQL database. First run downloads the package via npx (requires network, ~5 s latency).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Replace <connection-string> in the args with your Postgres connection URL (e.g. postgresql://user:pass@host:5432/dbname). The server connects in read-only mode.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres@0.6.2', '<connection-string>'],
  },
  {
    slug: 'mcp-playwright',
    label: 'Playwright',
    description:
      'Browser automation — navigate pages, click, type, screenshot, and extract content from the web via a headless browser. First run downloads the package via npx (requires network, ~10–30 s latency for browser binary).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'No API key required. Playwright launches a local headless browser — make sure Chromium or Chrome is available on the host machine.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.75'],
  },
  // ── HTTP servers ──────────────────────────────────────────────────────────
  {
    slug: 'linear',
    label: 'Linear',
    description:
      'Manage Linear issues, projects, teams, and cycles via a personal API key. Requires a Linear account.',
    serverUrl: null,
    transport: 'http',
    authScheme: 'bearer',
    authParamName: 'Authorization',
    keyPrefix: ['lin_api_'],
    verifyToolName: null,
    docsHint:
      'Create a Personal API key at https://linear.app/settings/api. Paste the full URL of your Linear MCP endpoint (format: https://mcp.linear.app/sse) and your API key.',
  },
  {
    slug: 'sentry',
    label: 'Sentry',
    description:
      'Query Sentry issues, events, and releases for debugging. Auth via a Sentry auth token.',
    serverUrl: null,
    transport: 'http',
    authScheme: 'bearer',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Create a Sentry Auth Token at https://sentry.io/settings/account/api/auth-tokens/. Paste the full URL of your Sentry MCP endpoint and your token.',
  },
  // ── Expansion batch (status: 'pending' — not yet live-verified) ───────────
  {
    slug: 'n8n',
    label: 'n8n',
    description:
      'Workflow automation — let an agent list, read, build, and trigger n8n workflows on your instance. Runs the n8n-mcp server locally via npx.',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Set N8N_API_URL to your n8n instance (e.g. https://n8n.example.com) and N8N_API_KEY to an API key from Settings → n8n API. First run downloads the package via npx.',
    command: 'npx',
    args: ['-y', 'n8n-mcp'],
    envVarNames: ['N8N_API_URL', 'N8N_API_KEY'],
    status: 'pending',
  },
  {
    slug: 'supabase',
    label: 'Supabase',
    description:
      'Manage a Supabase project — list tables, run read-only SQL, inspect logs and advisors. Runs the official Supabase MCP server locally via npx (read-only by default).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Replace <project-ref> in the args with your project ref (Project Settings → General). Set SUPABASE_ACCESS_TOKEN to a Personal Access Token from supabase.com/dashboard/account/tokens. Remove --read-only to allow writes.',
    command: 'npx',
    args: [
      '-y',
      '@supabase/mcp-server-supabase@latest',
      '--read-only',
      '--project-ref=<project-ref>',
    ],
    envVarNames: ['SUPABASE_ACCESS_TOKEN'],
    status: 'pending',
  },
  // NOTE: Vercel's hosted MCP (https://mcp.vercel.com) is OAuth-only — no
  // static PAT/bearer path — so it can't be connected via the static-key form.
  // Re-add once MCP OAuth lands (on the roadmap).
  {
    slug: 'airtable',
    label: 'Airtable',
    description:
      'Read and write Airtable bases — list bases and tables, query records, create and update rows. Official hosted Airtable MCP server.',
    serverUrl: 'https://mcp.airtable.com/mcp',
    transport: 'http',
    authScheme: 'bearer',
    authParamName: 'Authorization',
    keyPrefix: ['pat'],
    verifyToolName: null,
    docsHint:
      'Create a Personal Access Token at airtable.com/create/tokens (scopes: data.records:read/write, schema.bases:read) and paste it here as a Bearer token. (Airtable API keys are deprecated — use a PAT, which starts with "pat".) After connecting, pick which bases the integration can access at airtable.com/?integrations=thirdParty.',
  },
  {
    slug: 'notion',
    label: 'Notion',
    description:
      'Read and update Notion pages and databases — search, fetch, create, and edit content. Runs the official Notion MCP server locally via npx.',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Create an internal integration at notion.so/my-integrations, share the target pages/databases with it, and set NOTION_TOKEN to the integration secret (starts with ntn_). (Older package builds want OPENAPI_MCP_HEADERS instead — a JSON string {"Authorization":"Bearer ntn_…","Notion-Version":"2022-06-28"}.)',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envVarNames: ['NOTION_TOKEN'],
    status: 'pending',
  },
  {
    slug: 'perplexity',
    label: 'Perplexity',
    description:
      'Real-time web search and research — gives an agent perplexity_search, perplexity_ask, perplexity_research (deep research with citations), and perplexity_reason (Sonar models). Runs the official Perplexity MCP server locally via npx.',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Create an API key at https://console.perplexity.ai (Settings → API; keys start with pplx-) and set PERPLEXITY_API_KEY below. First run downloads the package via npx (requires network, ~5 s latency).',
    command: 'npx',
    args: ['-y', '@perplexity-ai/mcp-server@0.9.0'],
    envVarNames: ['PERPLEXITY_API_KEY'],
    status: 'pending',
  },
  {
    slug: 'apify',
    label: 'Apify',
    description:
      'Run Apify Actors — thousands of ready-made scrapers and automation tools for social media, search engines, maps, e-commerce, and any website. Connects to the hosted Apify MCP server.',
    serverUrl: 'https://mcp.apify.com',
    transport: 'http',
    authScheme: 'bearer',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Create an API token in the Apify Console (Settings → API & Integrations) and paste it here as a Bearer token. The hosted server runs Actors on your behalf.',
    status: 'pending',
  },
  // ── 3D / rendering (stdio) ────────────────────────────────────────────────
  // Each needs a companion plugin/add-on INSIDE the app (running locally) plus a
  // local bridge server. Marked 'pending' — the command/path may need adjusting
  // per the upstream README. All require the `uv` package manager on the host.
  {
    slug: 'blender',
    label: 'Blender',
    description:
      'Drive Blender from natural language — build/modify 3D scenes, objects, and materials, then render. Runs the popular blender-mcp server (ahujasid) locally via uvx.',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Install the BlenderMCP add-on from github.com/ahujasid/blender-mcp, open Blender 3.0+, and start its server (sidebar → BlenderMCP → Connect). Requires the `uv` package manager (uvx) on the host. No API key. (Blender also ships an official server at blender.org/lab/mcp-server.)',
    command: 'uvx',
    args: ['blender-mcp'],
    status: 'pending',
  },
  {
    slug: 'unity',
    label: 'Unity',
    description:
      'Bridge an AI to the Unity Editor — manage assets, control scenes, edit scripts, run tests. Uses CoplayDev’s MCP for Unity (MIT — successor to justinpbarnett/unity-mcp).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'In Unity: Window → Package Manager → Add package from git URL → https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main. That installs the Python bridge under the package; replace <unity-mcp-server-dir> in the args with its absolute path (…/MCPForUnity/UnityMcpServer~/src). Requires `uv`. Confirm the server entry in github.com/CoplayDev/unity-mcp.',
    command: 'uv',
    args: ['run', '--directory', '<unity-mcp-server-dir>', 'server.py'],
    status: 'pending',
  },
  {
    slug: 'unreal-engine',
    label: 'Unreal Engine',
    description:
      'Control Unreal Engine 5 from natural language — actors, Blueprints, procedural scene building. Uses the community unreal-mcp (chongdashu); Epic has no official MCP yet.',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Clone github.com/chongdashu/unreal-mcp, install its UnrealMCP plugin into your UE5 project’s Plugins/, then point the args at the repo’s Python server dir: replace <unreal-mcp-python-dir> with the absolute path to that folder. Requires `uv`. Community project — verify the entry script name in its README.',
    command: 'uv',
    args: ['run', '--directory', '<unreal-mcp-python-dir>', 'unreal_mcp_server.py'],
    status: 'pending',
  },
  {
    slug: 'keyshot',
    label: 'KeyShot',
    description:
      'Drive KeyShot rendering from an AI — import models, assign materials, set cameras/lighting, and render. Uses the keyshot-mcp bridge (pentatonic-ltd).',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Set up the KeyShot-side bridge per the keyshot-mcp project (pentatonic-ltd) — a KeyShot script plus the MCP server — then replace <keyshot-mcp-dir> with the absolute repo path. Requires `uv`. Niche project — confirm the entry script in its README.',
    command: 'uv',
    args: ['run', '--directory', '<keyshot-mcp-dir>', 'server.py'],
    status: 'pending',
  },
  {
    slug: 'photoshop',
    label: 'Photoshop',
    description:
      'Control Adobe Photoshop from natural language — documents, layers, text, filters, adjustments. Cross-platform (macOS + Windows) via the adb-mcp project (mikechambers, Adobe) using a UXP plugin.',
    serverUrl: null,
    transport: 'stdio',
    authScheme: 'header',
    authParamName: 'Authorization',
    keyPrefix: [],
    verifyToolName: null,
    docsHint:
      'Cross-platform (macOS + Windows). Set up adb-mcp (github.com/mikechambers/adb-mcp): (1) load its UXP plugin into Photoshop 26+ via the Adobe UXP Developer Tool, (2) run the Node proxy (node proxy.js in adb-proxy-socket — listens on ws://localhost:3001), (3) point this command at the repo — replace <adb-mcp-dir> with the absolute repo path. Requires `uv` + Node. Confirm the server entry (ps-mcp.py) in the README. Adobe ships no turnkey MCP. — Simpler WINDOWS-ONLY alternative: command "uvx", args ["photoshop-mcp-server"], env PS_VERSION (loonghao’s COM server).',
    command: 'uv',
    args: ['run', '--directory', '<adb-mcp-dir>', 'ps-mcp.py'],
    status: 'pending',
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
