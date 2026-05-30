/**
 * Maps an MCP catalog slug to one of the ChipRow category labels.
 *
 * Extracted from McpClient.tsx so that McpMarketplaceGrid can import it
 * without creating a circular dep (Client ⇄ Grid via this function).
 */
// Returned values MUST be one of the chip categories rendered in
// McpMarketplaceGrid (`CATEGORIES`): Comms, Data, Dev, Web, Productivity,
// Custom, Other. Any value outside that set would make those entries
// unreachable via the category chips (they'd only show under "All").
export function mcpCategory(slug: string): string {
  if (slug === 'cogni-cortex') return 'Comms';
  if (slug === 'stripe') return 'Data';
  if (slug === 'mcp-postgres') return 'Data';
  if (slug === 'supabase') return 'Data';
  if (slug === 'airtable') return 'Data';
  if (slug === 'mcp-filesystem') return 'Dev';
  if (slug === 'mcp-git') return 'Dev';
  if (slug === 'mcp-github') return 'Dev';
  if (slug === 'sentry') return 'Dev';
  if (slug === 'vercel') return 'Dev';
  if (slug === 'mcp-fetch') return 'Web';
  if (slug === 'mcp-playwright') return 'Web';
  if (slug === 'composio') return 'Productivity';
  if (slug === 'linear') return 'Productivity';
  if (slug === 'n8n') return 'Productivity';
  if (slug === 'notion') return 'Productivity';
  if (slug.startsWith('custom-')) return 'Custom';
  // mcp-sequential-thinking and anything new without an explicit mapping.
  return 'Other';
}
