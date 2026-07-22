import type { ChipItem } from '@/components/ui/ChipRow';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog.ts';
import type { ConnectorCategory } from '@nodal-agents/shared';

/** The category filter chips shown in the connectors / MCP toolbar (row 2). */
export const CONNECTOR_CATEGORIES: ChipItem<string>[] = [
  { value: 'All', label: 'All' },
  { value: 'CRM', label: 'CRM' },
  { value: 'Productivity', label: 'Productivity' },
  { value: 'Data', label: 'Data' },
  { value: 'DevTools', label: 'DevTools' },
  { value: 'Comms', label: 'Comms' },
  { value: 'Creative', label: 'Creative' },
  { value: 'Other', label: 'Other' },
];

/**
 * Looks up a catalog slug's marketplace category, from CatalogEntry.category
 * (packages/shared/src/connector-catalog.ts) — the field is required, so a
 * catalog entry can never silently omit its category. Previously this
 * derived the category by string-matching the slug (startsWith('google-'),
 * hardcoded slug lists) — a new connector that nobody remembered to add to
 * that matcher fell silently into 'Other'. A slug with no catalog entry at
 * all is a real bug (the catalog is the single source of truth for what
 * connectors exist), so this fails loud instead of guessing.
 *
 * Extracted from ConnectorsClient.tsx so that ConnectorsMarketplaceGrid
 * can import it without creating a circular dep (Client ⇄ Grid via this
 * function).
 */
export function catalogCategory(slug: string): ConnectorCategory {
  const entry = CONNECTOR_CATALOG.find((e) => e.slug === slug);
  if (!entry) {
    throw new Error(`catalogCategory: no catalog entry for slug "${slug}".`);
  }
  return entry.category;
}
