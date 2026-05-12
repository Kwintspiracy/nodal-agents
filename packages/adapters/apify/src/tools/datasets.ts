// @nodalai/adapter-apify — dataset tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { ApifyClient } from '../client.ts';
import { wrapApifyError } from '../errors.ts';

// ── apify_list_datasets ───────────────────────────────────────────────────────

const ListDatasetsInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(100)
    .describe('Maximum number of datasets to return (default 100, max 1000).'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of datasets to skip (for pagination). Default 0.'),
});

export type DatasetInfo = {
  id: string;
  name: string | null;
  itemCount: number;
  createdAt: string;
  modifiedAt: string;
};

export type ListDatasetsOutput = {
  datasets: DatasetInfo[];
  total: number;
  count: number;
  offset: number;
};

export function makeApifyListDatasetsTool(
  client: ApifyClient,
): ToolDefinition<typeof ListDatasetsInput, ListDatasetsOutput> {
  return {
    name: 'apify_list_datasets',
    description:
      "List datasets in the user's Apify account. Returns dataset IDs and names needed for apify_get_dataset_items.",
    inputSchema: ListDatasetsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const result = await client.datasets().list({
          limit: input.limit ?? 100,
          offset: input.offset ?? 0,
        });
        return {
          datasets: result.items.map((d) => ({
            id: d.id,
            name: d.name ?? null,
            itemCount: d.itemCount ?? 0,
            createdAt: d.createdAt.toISOString(),
            modifiedAt: d.modifiedAt.toISOString(),
          })),
          total: result.total,
          count: result.count,
          offset: result.offset,
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}

// ── apify_get_dataset_items ───────────────────────────────────────────────────

const GetDatasetItemsInput = z.object({
  datasetId: z
    .string()
    .describe(
      'The Apify dataset ID to read from. Use apify_run_actor to get the datasetId from a run, or apify_list_datasets to browse existing datasets.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(100)
    .describe('Maximum number of items to return (default 100, max 1000).'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of items to skip (for pagination). Default 0.'),
});

export type GetDatasetItemsOutput = {
  items: unknown[];
  total: number;
  count: number;
  offset: number;
};

export function makeApifyGetDatasetItemsTool(
  client: ApifyClient,
): ToolDefinition<typeof GetDatasetItemsInput, GetDatasetItemsOutput> {
  return {
    name: 'apify_get_dataset_items',
    description:
      'Retrieve items from an Apify dataset. Use the datasetId returned by apify_run_actor or from apify_list_datasets. Supports limit/offset pagination (max 1000 items per call).',
    inputSchema: GetDatasetItemsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const result = await client.dataset(input.datasetId).listItems({
          limit: input.limit ?? 100,
          offset: input.offset ?? 0,
        });
        return {
          items: result.items,
          total: result.total,
          count: result.count,
          offset: result.offset,
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}
