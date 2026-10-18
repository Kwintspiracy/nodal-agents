// @nodal-agents/adapter-tavily — public API
// Single factory: createTavilyTools(opts) → ConnectorToolDefinition[]
//
// Tools exposed (3 total — all read-level):
//   tavily_search   — web search via Tavily
//   tavily_extract  — full-page content extraction from URLs
//   tavily_crawl    — recursive site crawl from a seed URL
//
// SDK: @tavily/core v0.7.x (official Tavily JS client).
// All three tools (search, extract, crawl) are natively supported by the SDK.
// No hand-rolled HTTP anywhere in this adapter.

import type { ConnectorToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createTavilyClient } from './client.ts';
import {
  makeTavilySearchTool,
  makeTavilyExtractTool,
  makeTavilyCrawlTool,
} from './tools/search.ts';

/**
 * Auth options for the Tavily adapter.
 * Pass your Tavily API key via `{ accessToken }`.
 */
export type TavilyAdapterOptions = {
  accessToken: string;
};

/**
 * Create all 3 Tavily tools using the provided API key.
 * Returns a flat ConnectorToolDefinition[]: risk and default approval come
 * from the operation descriptors, applied by ADAPTER_REGISTRY (issue #735).
 *
 * Tool count: 3
 * Read (3): tavily_search, tavily_extract, tavily_crawl
 */
export function createTavilyTools(
  opts: TavilyAdapterOptions,
): ConnectorToolDefinition<z.ZodTypeAny, unknown>[] {
  if (!opts.accessToken) {
    throw new Error('TavilyAdapterOptions: accessToken must be a non-empty string.');
  }

  const client = createTavilyClient(opts.accessToken);

  return [
    makeTavilySearchTool(client),
    makeTavilyExtractTool(client),
    makeTavilyCrawlTool(client),
  ] as unknown as ConnectorToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { TavilyApiError } from './errors.ts';
export type { TavilyErrorCode } from './errors.ts';

// Re-export operation descriptors for UI and registry consumers
export { TAVILY_OPERATIONS } from './operations.ts';
