// @nodal-agents/adapter-notion — pagination helper for Notion's cursor-based API

import type { Client } from '@notionhq/client';
import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';

/**
 * Paginate a Notion list endpoint by following `next_cursor`.
 *
 * @param fetcher  - Function that accepts (start_cursor | undefined, page_size) and returns
 *                   a Notion list response with `results`, `has_more`, and `next_cursor`.
 * @param pageSize - Page size per request (max 100 per Notion limits).
 * @param maxItems - Hard ceiling on total items collected (default 500).
 * @returns        Flat array of all collected results.
 *
 * Guard: max 20 page fetches to prevent runaway loops (20 × 100 = 2000 max rows).
 */
export async function paginateAll<T>(
  fetcher: (
    cursor: string | undefined,
    pageSize: number,
  ) => Promise<{
    results: T[];
    has_more: boolean;
    next_cursor: string | null;
  }>,
  pageSize = 100,
  maxItems = 500,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined = undefined;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetcher(cursor, Math.min(pageSize, 100));
    items.push(...response.results);

    if (items.length >= maxItems || !response.has_more || !response.next_cursor) {
      break;
    }
    cursor = response.next_cursor;
  }

  return items.slice(0, maxItems);
}

/**
 * Paginate block children for a given block/page ID.
 * Returns a flat array of all child blocks (not recursed).
 */
export async function paginateBlockChildren(
  client: Client,
  blockId: string,
  maxBlocks = 300,
): Promise<BlockObjectResponse[]> {
  return paginateAll<BlockObjectResponse>(
    async (cursor, pageSize) => {
      const res = await client.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: pageSize,
      });
      return {
        results: res.results.filter((b): b is BlockObjectResponse => b.object === 'block'),
        has_more: res.has_more,
        next_cursor: res.next_cursor,
      };
    },
    100,
    maxBlocks,
  );
}
