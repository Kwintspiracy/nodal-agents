// @nodal-agents/adapter-apify — thin wrapper around the official apify-client SDK
// Uses ApifyClient from 'apify-client' — no hand-rolled HTTP.

import { ApifyClient } from 'apify-client';
import { ApifyApiError } from './errors.ts';

export type { ApifyClient };

/**
 * Create an ApifyClient scoped to the provided access token.
 * The client is a thin wrapper — all network calls are delegated to the
 * official apify-client SDK which handles retries, rate limiting, and
 * automatic response parsing.
 */
export function createApifyClient(accessToken: string): ApifyClient {
  return new ApifyClient({ token: accessToken });
}

// Re-export error type for tools
export { ApifyApiError };
