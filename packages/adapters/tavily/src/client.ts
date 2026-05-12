// @nodalai/adapter-tavily — thin wrapper around @tavily/core
// Uses the official SDK exclusively — no hand-rolled HTTP.

import { tavily } from '@tavily/core';
import type {
  TavilyClient as TavilySdkClient,
  TavilySearchOptions,
  TavilySearchResponse,
  TavilyExtractOptions,
  TavilyExtractResponse,
  TavilyCrawlOptions,
  TavilyCrawlResponse,
} from '@tavily/core';

export type TavilyClient = {
  search: (query: string, options?: TavilySearchOptions) => Promise<TavilySearchResponse>;
  extract: (urls: string[], options?: TavilyExtractOptions) => Promise<TavilyExtractResponse>;
  crawl: (url: string, options?: TavilyCrawlOptions) => Promise<TavilyCrawlResponse>;
};

/**
 * Create a thin Tavily client wrapping the official @tavily/core SDK.
 * The SDK handles all HTTP, auth headers, and retry logic internally.
 */
export function createTavilyClient(accessToken: string): TavilyClient {
  const sdk: TavilySdkClient = tavily({ apiKey: accessToken });

  return {
    search: (query, options) => sdk.search(query, options),
    extract: (urls, options) => sdk.extract(urls, options),
    crawl: (url, options) => sdk.crawl(url, options),
  };
}

// Re-export error types used by tools
export { TavilyApiError } from './errors.ts';
