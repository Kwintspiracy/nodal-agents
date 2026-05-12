// @nodalai/adapter-firecrawl — operation descriptors.
// Each slug MUST match the tool name produced by createFirecrawlTools() exactly.
// Risk classification:
//   read — all Firecrawl operations are read-only (scrape, crawl, map, search)
//   No write or destructive operations exist in the Firecrawl API.

import type { OperationDescriptor } from '@nodalai/shared';

export const FIRECRAWL_OPERATIONS: OperationDescriptor[] = [
  // ─── Read (5) ────────────────────────────────────────────────────────────────
  {
    slug: 'firecrawl_scrape',
    name: 'Scrape page',
    risk: 'read',
    requiresApproval: false,
    description: 'Scrape a single URL and return its content as markdown, HTML, and/or links.',
  },
  {
    slug: 'firecrawl_crawl_start',
    name: 'Start crawl',
    risk: 'read',
    requiresApproval: false,
    description:
      'Start an async crawl job for a site. Returns a job ID to poll with firecrawl_crawl_status.',
  },
  {
    slug: 'firecrawl_crawl_status',
    name: 'Get crawl status',
    risk: 'read',
    requiresApproval: false,
    description: 'Poll the status and partial results of a Firecrawl crawl job by its ID.',
  },
  {
    slug: 'firecrawl_map',
    name: 'Map site',
    risk: 'read',
    requiresApproval: false,
    description: 'Discover all URLs on a site (sitemap-aware). Optionally filter by a search term.',
  },
  {
    slug: 'firecrawl_search',
    name: 'Search web',
    risk: 'read',
    requiresApproval: false,
    description: 'Search the web via Firecrawl and return structured results.',
  },
];
