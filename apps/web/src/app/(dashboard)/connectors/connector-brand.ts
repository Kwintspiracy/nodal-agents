/**
 * connector-brand.ts — brand colour + glyph lookup for the Installed table
 * and Marketplace card glyphs.
 *
 * Hard-coded by design spec — these are provider brand identities.
 * For slugs not listed here, falls back to the conn-vivid blue (via Disc
 * variant="conn", no background override).
 */

export const CONN_BRAND_COLORS: Record<string, string> = {
  gmail: '#ea4335',
  'google-drive': '#4285f4',
  'google-sheets': '#0f9d58',
  'google-docs': '#4285f4',
  'google-calendar': '#4285f4',
  notion: '#000000',
  'notion-oauth': '#000000',
  airtable: '#f82b60',
  'airtable-oauth': '#f82b60',
  github: '#24292f',
  linear: '#5e6ad2',
  hubspot: '#ff7a59',
  slack: '#4a154b',
  intercom: '#1f8ced',
  stripe: '#635bff',
  postgres: '#336791',
  apify: '#00aeff',
  firecrawl: '#f97316',
  tavily: '#6366f1',
  composio: '#000000',
};

/**
 * Returns a 2-4 character monogram for the connector glyph disc.
 * Prefers well-known short forms; falls back to the first 2 chars of the label.
 */
const CONN_GLYPHS: Record<string, string> = {
  gmail: 'Gm',
  'google-drive': 'GD',
  'google-sheets': 'GS',
  'google-docs': 'GD',
  'google-calendar': 'GC',
  notion: 'No',
  'notion-oauth': 'No',
  airtable: 'At',
  'airtable-oauth': 'At',
  github: 'Gh',
  linear: 'Li',
  hubspot: 'HS',
  slack: 'Sl',
  intercom: 'IC',
  stripe: 'St',
  postgres: 'PG',
  apify: 'Ap',
  firecrawl: 'FC',
  tavily: 'Tv',
  composio: 'Co',
  'custom-http-mcp': '+',
  'custom-stdio-mcp': '+',
  'cogni-cortex': 'CX',
  keyshot: 'KS',
  photoshop: 'Ps',
};

export function connGlyph(slug: string, label: string): string {
  return CONN_GLYPHS[slug] ?? label.slice(0, 2).toUpperCase();
}

/**
 * Brand SVG icon for a connector, served from /public/connector-icons. Returns
 * null when we don't have a brand icon for the slug — the caller falls back to
 * the monogram glyph. OAuth variants share the base brand's icon.
 */
const CONN_ICONS: Record<string, string> = {
  // API connectors
  notion: '/connector-icons/notion.svg',
  'notion-oauth': '/connector-icons/notion.svg',
  'google-drive': '/connector-icons/google-drive.svg',
  gmail: '/connector-icons/gmail.svg',
  'google-sheets': '/connector-icons/google-sheets.svg',
  'google-docs': '/connector-icons/google-docs.svg',
  'google-calendar': '/connector-icons/google-calendar.svg',
  airtable: '/connector-icons/airtable.svg',
  'airtable-oauth': '/connector-icons/airtable.svg',
  // MCP connectors (slugs from the MCP catalog)
  stripe: '/connector-icons/stripe.svg',
  sentry: '/connector-icons/sentry.svg',
  'mcp-github': '/connector-icons/github.svg',
  'mcp-postgres': '/connector-icons/postgresql.svg',
  'mcp-git': '/connector-icons/git.svg',
  // 3D / creative MCP connectors (brand SVGs from simple-icons)
  blender: '/connector-icons/blender.svg',
  unity: '/connector-icons/unity.svg',
  'unreal-engine': '/connector-icons/unreal-engine.svg',
  photoshop: '/connector-icons/photoshop.svg',
  // Filled from Devicon (full-colour) where available, else simple-icons (mono).
  'mcp-playwright': '/connector-icons/playwright.svg',
  supabase: '/connector-icons/supabase.svg',
  perplexity: '/connector-icons/perplexity.svg',
  linear: '/connector-icons/linear.svg',
  n8n: '/connector-icons/n8n.svg',
};

export function connIcon(slug: string): string | null {
  return CONN_ICONS[slug] ?? null;
}
