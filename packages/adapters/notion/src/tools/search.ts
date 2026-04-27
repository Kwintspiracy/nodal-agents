// @nodalai/adapter-notion — notion_search tool

import { z } from 'zod';
import type { ToolDefinition } from '@nodalai/tools';
import type { Client } from '@notionhq/client';
import { mapNotionError } from '../errors.js';
import { extractTitle } from '../helpers/property-coerce.js';

const SearchInput = z.object({
  query: z.string().describe('Text to search for in page and database titles.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Max results to return (1–100, default 10).'),
  filter_type: z
    .enum(['page', 'database'])
    .optional()
    .describe('Optional: restrict results to pages or databases only.'),
});

export type SearchOutput = {
  total: number;
  results: Array<{
    object: string;
    id: string;
    title: string;
    url: string;
  }>;
};

export function createSearchTool(client: Client): ToolDefinition<typeof SearchInput, SearchOutput> {
  return {
    name: 'notion_search',
    description:
      'Search across all pages and databases in Notion. Returns matching page titles, IDs, and URLs.',
    inputSchema: SearchInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const body: Parameters<typeof client.search>[0] = {
          query: input.query,
          page_size: input.limit,
        };
        if (input.filter_type) {
          body.filter = { property: 'object', value: input.filter_type };
        }

        const res = await client.search(body);
        const results = res.results.map((item) => {
          const obj = item.object;
          // Both PageObjectResponse and DatabaseObjectResponse have id, url, and properties/title
          const id = item.id;
          const url = 'url' in item ? (item.url as string) : '';
          const title = extractTitle(
            item as {
              properties?: Record<string, { type: string; [k: string]: unknown }>;
              title?: Array<{ plain_text: string }>;
            },
          );
          return { object: obj, id, title, url };
        });

        return { total: results.length, results };
      } catch (err) {
        throw mapNotionError(err);
      }
    },
  };
}
