/**
 * Maps an MCP catalog slug to one of the ChipRow category labels.
 *
 * Extracted from McpClient.tsx so that McpMarketplaceGrid can import it
 * without creating a circular dep (Client ⇄ Grid via this function).
 */
export function mcpCategory(slug: string): string {
  if (slug === 'stripe') return 'Data';
  if (slug === 'composio') return 'Productivity';
  if (slug === 'cogni-cortex') return 'Comms';
  if (slug === 'mcp-filesystem') return 'Files';
  if (slug === 'mcp-fetch') return 'Web';
  if (slug === 'mcp-git') return 'Dev';
  if (slug === 'mcp-github') return 'Dev';
  if (slug === 'mcp-postgres') return 'Data';
  if (slug === 'mcp-sequential-thinking') return 'Reasoning';
  if (slug === 'mcp-playwright') return 'Web';
  if (slug === 'linear') return 'Productivity';
  if (slug === 'sentry') return 'Dev';
  if (slug.startsWith('custom-')) return 'Custom';
  return 'Other';
}
