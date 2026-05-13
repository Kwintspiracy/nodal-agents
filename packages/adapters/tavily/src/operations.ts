// @nodal-agents/adapter-tavily — operation descriptors.
// Each slug MUST match the tool name produced by createTavilyTools() exactly.
// Risk classification:
//   read — all Tavily operations (search, extract, crawl are read-only)

import type { OperationDescriptor } from '@nodal-agents/shared';

export const TAVILY_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (3) ────────────────────────────────────────────────────────────────
  {
    slug: 'tavily_search',
    name: 'Web search',
    risk: 'read',
    requiresApproval: false,
    description:
      'Search the web using Tavily. Returns ranked results with titles, URLs, and content snippets.',
  },
  {
    slug: 'tavily_extract',
    name: 'Extract content',
    risk: 'read',
    requiresApproval: false,
    description: 'Extract the full text content from one or more URLs (max 20).',
  },
  {
    slug: 'tavily_crawl',
    name: 'Crawl site',
    risk: 'read',
    requiresApproval: false,
    description:
      'Crawl from a seed URL and return scraped content for all reachable pages up to a depth and limit.',
  },
];
