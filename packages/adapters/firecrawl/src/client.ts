// @nodalai/adapter-firecrawl — thin wrapper around @mendable/firecrawl-js
// Auth: API key passed to FirecrawlClient constructor as `apiKey`.
// Uses the official SDK (v2 client) — no hand-rolled HTTP.

import { FirecrawlClient } from '@mendable/firecrawl-js';
import { FirecrawlApiError } from './errors.ts';

export type { FirecrawlClient };

/**
 * Create a FirecrawlClient using the provided API key.
 * The SDK handles all transport, retries and auth headers internally.
 */
export function createFirecrawlClient(apiKey: string): FirecrawlClient {
  return new FirecrawlClient({ apiKey });
}

// Re-export error types used by tools
export { FirecrawlApiError };
