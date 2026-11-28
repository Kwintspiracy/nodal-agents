// @nodal-agents/adapter-notion — Notion SDK client factory

import { Client } from '@notionhq/client';

/**
 * Create a @notionhq/client instance with the given API key.
 * The key is validated at call-time by the Notion API — we don't pre-validate.
 */
export function createNotionClient(apiKey: string, transport?: typeof fetch): Client {
  // `fetch`: the connector contract's transport, given by the registry.
  return new Client({ auth: apiKey, ...(transport ? { fetch: transport } : {}) });
}
