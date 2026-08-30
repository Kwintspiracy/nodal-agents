// recipe-connectors.test.ts — every connector a recipe recommends must exist
// in the MCP catalog, and the projection must say what the user still owes.

import { describe, it, expect } from 'vitest';
import { MCP_CATALOG } from '@nodal-agents/shared';
import { agentRecipes } from '@nodal-agents/catalog';
import { recipeConnectorMeta } from '../recipe-connectors.ts';

const catalogSlugs = new Set(MCP_CATALOG.map((e) => e.slug));

describe('recipe connectors', () => {
  it('every recommended connector is a real MCP catalog entry', () => {
    for (const r of agentRecipes) {
      for (const c of r.connectors ?? []) {
        expect(catalogSlugs.has(c.slug), `${r.slug} → ${c.slug}`).toBe(true);
      }
    }
    expect(agentRecipes.some((r) => (r.connectors ?? []).length > 0)).toBe(true);
  });

  it('Playwright: no API key, installed only when the workspace has an instance', () => {
    const none = recipeConnectorMeta(MCP_CATALOG, []);
    expect(none['mcp-playwright']).toMatchObject({
      label: 'Playwright',
      needsApiKey: false,
      installed: false,
    });
    expect(none['mcp-playwright']?.setupHint).toMatch(/No API key required/);

    const some = recipeConnectorMeta(MCP_CATALOG, ['mcp-playwright']);
    expect(some['mcp-playwright']?.installed).toBe(true);
  });

  it('is limited to the connectors the recipes recommend', () => {
    const meta = recipeConnectorMeta(MCP_CATALOG, []);
    expect(Object.keys(meta).length).toBeLessThan(MCP_CATALOG.length);
  });
});
