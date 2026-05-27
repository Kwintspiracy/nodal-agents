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
  if (slug.startsWith('custom-')) return 'Custom';
  return 'Other';
}
