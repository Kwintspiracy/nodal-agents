/**
 * Maps an MCP catalog slug to one of the ChipRow category labels.
 *
 * Extracted from McpClient.tsx so that McpMarketplaceGrid can import it
 * without creating a circular dep (Client ⇄ Grid via this function).
 */
// Returned values MUST be one of the shared chip categories rendered in the
// MCP toolbar (`CONNECTOR_CATEGORIES` from ../connectors/categories.ts):
// CRM, Productivity, Data, DevTools, Comms, Creative, Other. Any value
// outside that set would make those entries unreachable via the category
// chips (they'd only show under "All"). Custom MCP entries map to "Other"
// since there is no dedicated "Custom" chip in the shared list.
export function mcpCategory(slug: string): string {
  if (slug === 'cogni-cortex') return 'Comms';
  if (slug === 'stripe') return 'Data';
  if (slug === 'mcp-postgres') return 'Data';
  if (slug === 'supabase') return 'Data';
  if (slug === 'airtable') return 'Data';
  if (slug === 'mcp-fetch') return 'Data';
  if (slug === 'mcp-playwright') return 'Data';
  if (slug === 'apify') return 'Data';
  if (slug === 'mcp-filesystem') return 'DevTools';
  if (slug === 'mcp-git') return 'DevTools';
  if (slug === 'mcp-github') return 'DevTools';
  if (slug === 'sentry') return 'DevTools';
  if (slug === 'composio') return 'Productivity';
  if (slug === 'linear') return 'Productivity';
  if (slug === 'n8n') return 'Productivity';
  if (slug === 'notion') return 'Productivity';
  if (slug === 'blender') return 'Creative';
  if (slug === 'unity') return 'Creative';
  if (slug === 'unreal-engine') return 'Creative';
  if (slug === 'keyshot') return 'Creative';
  if (slug === 'photoshop') return 'Creative';
  if (slug === 'vidiq') return 'Creative';
  // Custom entries + anything new without an explicit mapping.
  return 'Other';
}
