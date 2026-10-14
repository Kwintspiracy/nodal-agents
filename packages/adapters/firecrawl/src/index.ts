// @nodal-agents/adapter-firecrawl — public API
// Single factory: createFirecrawlTools(opts) → ConnectorToolDefinition[]

import type { ConnectorToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createFirecrawlClient } from './client.ts';
import {
  makeFirecrawlScrapeTool,
  makeFirecrawlMapTool,
  makeFirecrawlSearchTool,
} from './tools/scrape.ts';
import { makeFirecrawlCrawlStartTool, makeFirecrawlCrawlStatusTool } from './tools/crawl.ts';

/**
 * Auth options for the Firecrawl adapter.
 * Pass your Firecrawl API key via `{ accessToken }`.
 */
export type FirecrawlAdapterOptions = {
  accessToken: string;
};

/**
 * Create all 5 Firecrawl tools using the provided API key.
 * Returns a flat ConnectorToolDefinition[]: risk and default approval come
 * from the operation descriptors, applied by ADAPTER_REGISTRY (issue #735).
 *
 * Tool count: 5
 * Read (5): firecrawl_scrape, firecrawl_crawl_start, firecrawl_crawl_status,
 *           firecrawl_map, firecrawl_search
 *
 * Note: All Firecrawl operations are read-only (no write/destructive ops exist).
 */
export function createFirecrawlTools(
  opts: FirecrawlAdapterOptions,
): ConnectorToolDefinition<z.ZodTypeAny, unknown>[] {
  if (!opts.accessToken) {
    throw new Error('FirecrawlAdapterOptions: accessToken must be a non-empty string.');
  }

  const client = createFirecrawlClient(opts.accessToken);

  return [
    makeFirecrawlScrapeTool(client),
    makeFirecrawlCrawlStartTool(client),
    makeFirecrawlCrawlStatusTool(client),
    makeFirecrawlMapTool(client),
    makeFirecrawlSearchTool(client),
  ] as unknown as ConnectorToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { FirecrawlApiError } from './errors.ts';
export type { FirecrawlErrorCode } from './errors.ts';

// Re-export operation descriptors for UI and registry consumers
export { FIRECRAWL_OPERATIONS } from './operations.ts';
