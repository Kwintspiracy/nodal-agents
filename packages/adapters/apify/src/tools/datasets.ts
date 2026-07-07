// @nodal-agents/adapter-apify — dataset tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { ApifyClient } from '../client.ts';
import { wrapApifyError } from '../errors.ts';

// audit#2026-07-07 F5: apify_get_dataset_items returned `result.items` verbatim
// — an item can be a whole scraped page (e.g. a full HTML doc as one dataset
// field), so a 1000-item page could burn the agent's whole token budget on a
// single tool result. Same cap + truncated flag pattern as
// firecrawl/scrape.ts, tavily/search.ts, google-drive/read-file.ts — but those
// cap one known string field, whereas a dataset item's shape is arbitrary
// (whatever the actor produced), so we cap the item's JSON serialization
// instead of a named field.
const ITEM_CHAR_CAP = 15000;

/** Cap a dataset item at ITEM_CHAR_CAP chars of its JSON form. Oversized items are replaced with a preview + truncated marker. */
function capItem(item: unknown): { item: unknown; truncated: boolean } {
  const json = JSON.stringify(item) ?? '';
  if (json.length <= ITEM_CHAR_CAP) return { item, truncated: false };
  return {
    item: {
      __truncated: true,
      preview: json.slice(0, ITEM_CHAR_CAP),
      originalCharCount: json.length,
    },
    truncated: true,
  };
}

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
  /** true if any item exceeded ITEM_CHAR_CAP and was replaced with a preview (audit#2026-07-07 F5). */
  truncated: boolean;
};

export function makeApifyGetDatasetItemsTool(
  client: ApifyClient,
): ToolDefinition<typeof GetDatasetItemsInput, GetDatasetItemsOutput> {
  return {
    name: 'apify_get_dataset_items',
    description:
      'Retrieve items from an Apify dataset. Use the datasetId returned by apify_run_actor or from apify_list_datasets. Supports limit/offset pagination (max 1000 items per call). ' +
      `Each item is capped at ${ITEM_CHAR_CAP} chars of JSON — see the truncated flag.`,
    inputSchema: GetDatasetItemsInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const result = await client.dataset(input.datasetId).listItems({
          limit: input.limit ?? 100,
          offset: input.offset ?? 0,
        });
        const capped = result.items.map(capItem);
        return {
          items: capped.map((c) => c.item),
          total: result.total,
          count: result.count,
          offset: result.offset,
          truncated: capped.some((c) => c.truncated),
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}
