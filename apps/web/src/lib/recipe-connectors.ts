// recipe-connectors.ts — what a profile screen says about a recommended
// connector, and whether this workspace already has it.
//
// A recipe recommends connectors by MCP-catalog slug (RecipeConnector). The
// picker shows a count, the detail panel shows each one with what it takes:
// "ready" when an instance exists in the workspace (it will be attached to the
// new agent), otherwise what the user must provide — an API key, or just a
// first-run install for a key-less local server like Playwright.
//
// Computed on the server page: the MCP catalog is data-as-code, the installed
// instances come from the DB.

import type { McpCatalogEntry } from '@nodal-agents/shared';
import { agentRecipes } from '@nodal-agents/catalog';

export interface RecipeConnectorMeta {
  slug: string;
  label: string;
  description: string;
  /** HTTP servers need a key; stdio servers run locally with env vars only. */
  needsApiKey: boolean;
  /** The catalog's own setup note — where the key comes from, what to install. */
  setupHint: string;
  /** An instance exists in this workspace: the recipe will attach it. */
  installed: boolean;
}

export function recipeConnectorMeta(
  catalog: readonly McpCatalogEntry[],
  installedSlugs: Iterable<string>,
): Record<string, RecipeConnectorMeta> {
  const wanted = new Set(agentRecipes.flatMap((r) => (r.connectors ?? []).map((c) => c.slug)));
  const installed = new Set(installedSlugs);
  const out: Record<string, RecipeConnectorMeta> = {};
  for (const e of catalog) {
    if (!wanted.has(e.slug)) continue;
    out[e.slug] = {
      slug: e.slug,
      label: e.label,
      description: e.description,
      needsApiKey: e.transport === 'http',
      setupHint: e.docsHint,
      installed: installed.has(e.slug),
    };
  }
  return out;
}
