import { describe, it, expect } from 'vitest';
import { MCP_CATALOG } from '../src/lib/mcp-catalog.ts';
import { mcpCategory } from '../src/app/(dashboard)/mcp/categories.ts';
import { CONNECTOR_CATEGORIES } from '../src/app/(dashboard)/connectors/categories.ts';

// The MCP toolbar now uses the SHARED CONNECTOR_CATEGORIES chip list (the same
// chips as the connectors page). "All" is the no-filter default and is never
// returned by mcpCategory(); every other chip value is a valid return. A
// category outside this set would make those entries unreachable via the chips —
// the exact bug this test guards against.
const CHIP_CATEGORIES = new Set(
  CONNECTOR_CATEGORIES.map((c) => c.value).filter((v) => v !== 'All'),
);

describe('mcpCategory', () => {
  it('maps every catalog slug to a filterable chip category', () => {
    for (const entry of MCP_CATALOG) {
      expect(CHIP_CATEGORIES.has(mcpCategory(entry.slug))).toBe(true);
    }
  });
});
