/**
 * Maps a catalog slug to one of the ChipRow category labels.
 * Derived from the slug + authType — no extra column needed.
 *
 * Extracted from ConnectorsClient.tsx so that ConnectorsMarketplaceGrid
 * can import it without creating a circular dep (Client ⇄ Grid via this
 * function).
 */
export function catalogCategory(slug: string): string {
  if (slug.startsWith('google-') || slug === 'gmail') return 'Productivity';
  if (
    slug === 'notion' ||
    slug === 'notion-oauth' ||
    slug === 'airtable' ||
    slug === 'airtable-oauth'
  )
    return 'Productivity';
  if (slug === 'github') return 'DevTools';
  if (slug === 'linear') return 'DevTools';
  if (slug === 'hubspot') return 'CRM';
  if (slug === 'slack') return 'Comms';
  if (slug === 'intercom') return 'Comms';
  if (slug === 'apify' || slug === 'firecrawl' || slug === 'tavily') return 'Data';
  if (slug === 'stripe') return 'Data';
  if (slug === 'postgres') return 'Data';
  return 'Other';
}
