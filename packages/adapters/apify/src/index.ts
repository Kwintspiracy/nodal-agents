// @nodalai/adapter-apify — public API
// Single factory: createApifyTools(opts) → ToolDefinition[]

import type { ToolDefinition } from '@nodalai/tools';
import type { z } from 'zod';
import { createApifyClient } from './client.ts';
import { makeApifyRunActorTool, makeApifyGetRunTool } from './tools/actors.ts';
import { makeApifyListDatasetsTool, makeApifyGetDatasetItemsTool } from './tools/datasets.ts';

/**
 * Auth options for the Apify adapter.
 * Pass the Apify API access token from the user's Apify account settings.
 */
export type ApifyAdapterOptions = {
  accessToken: string;
};

/**
 * Create all 4 Apify tools using the provided access token.
 * Returns a flat ToolDefinition[] ready to register in a ToolRegistry.
 *
 * Tool count: 4
 * Write (1): apify_run_actor  (spawns a run and consumes Apify credits)
 * Read  (3): apify_get_run, apify_list_datasets, apify_get_dataset_items
 */
export function createApifyTools(
  opts: ApifyAdapterOptions,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  if (!opts.accessToken) {
    throw new Error('ApifyAdapterOptions: accessToken must be a non-empty string.');
  }

  const client = createApifyClient(opts.accessToken);

  return [
    // Write tools (1)
    makeApifyRunActorTool(client),

    // Read tools (3)
    makeApifyGetRunTool(client),
    makeApifyListDatasetsTool(client),
    makeApifyGetDatasetItemsTool(client),
  ] as unknown as ToolDefinition<z.ZodTypeAny, unknown>[];
}

// Re-export error types for consumers
export { ApifyApiError } from './errors.ts';
export type { ApifyErrorCode } from './errors.ts';

// Re-export operation descriptors for UI and registry consumers
export { APIFY_OPERATIONS } from './operations.ts';
