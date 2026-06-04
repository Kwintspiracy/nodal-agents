// @nodal-agents/adapter-apify — public API
// Single factory: createApifyTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodal-agents/tools';
import type { z } from 'zod';
import { createApifyClient } from './client.ts';
import {
  makeApifyWebBrowseTool,
  makeApifyRunActorTool,
  makeApifyGetRunTool,
} from './tools/actors.ts';
import { makeApifyListDatasetsTool, makeApifyGetDatasetItemsTool } from './tools/datasets.ts';

/**
 * Auth options for the Apify adapter.
 * Pass the Apify API access token from the user's Apify account settings.
 */
export type ApifyAdapterOptions = {
  accessToken: string;
};

/**
 * Create all 5 Apify tools using the provided access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 5
 * Write (1): apify_run_actor  (spawns a run and consumes Apify credits)
 * Read  (4): apify_web_browse (sync scrape/search), apify_get_run,
 *            apify_list_datasets, apify_get_dataset_items
 */
export function createApifyTools(
  opts: ApifyAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  if (!opts.accessToken) {
    throw new Error('ApifyAdapterOptions: accessToken must be a non-empty string.');
  }

  const client = createApifyClient(opts.accessToken);

  return [
    // Read tools (4) — apify_web_browse is the DEFAULT web tool (synchronous)
    makeApifyWebBrowseTool(client),
    makeApifyGetRunTool(client),
    makeApifyListDatasetsTool(client),
    makeApifyGetDatasetItemsTool(client),

    // Write tools (1)
    makeApifyRunActorTool(client),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { ApifyApiError } from './errors.ts';
export type { ApifyErrorCode } from './errors.ts';

// Re-export operation descriptors for UI and registry consumers
export { APIFY_OPERATIONS } from './operations.ts';
