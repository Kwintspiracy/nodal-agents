import { describe, it, expect } from 'vitest';
import { MCP_CATALOG } from '../src/lib/mcp-catalog.ts';
import { mcpCategory } from '../src/app/(dashboard)/mcp/categories.ts';

// Must stay in sync with the CATEGORIES chip list in McpMarketplaceGrid.tsx.
// A category returned by mcpCategory() that isn't in this set would make those
// entries unreachable via the category chips (only visible under "All") — the
// exact bug this test guards against.
const CHIP_CATEGORIES = new Set([
  'Comms',
  'Data',
  'Dev',
  'Web',
  'Productivity',
  'Creative',
  'Custom',
  'Other',
]);

describe('mcpCategory', () => {
  it('maps every catalog slug to a filterable chip category', () => {
    for (const entry of MCP_CATALOG) {
      expect(CHIP_CATEGORIES.has(mcpCategory(entry.slug))).toBe(true);
    }
  });
});
