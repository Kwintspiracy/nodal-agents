// @nodalai/adapter-gmail — pagination helper for Gmail's pageToken API

/**
 * Paginate a Gmail list endpoint by following `nextPageToken`.
 *
 * Gmail API uses pageToken for continuation and maxResults per page (max 500).
 * Default cap is 100 items; hard ceiling is 500 (Gmail's max page size).
 *
 * Guard: max 20 page fetches to prevent runaway loops (20 × 100 = 2000 max items).
 *
 * @param fetcher  - Function accepting (pageToken | undefined, pageSize) and returning
 *                   a list response with `items` and optional `nextPageToken`.
 * @param pageSize - Items per page request (max 500 per Gmail limits).
 * @param maxItems - Hard ceiling on total items collected (default 100, max 500).
 * @returns        Flat array of all collected items.
 */
export async function paginateGmail<T>(
  fetcher: (
    pageToken: string | undefined,
    pageSize: number,
  ) => Promise<{
    items: T[];
    nextPageToken?: string | null | undefined;
  }>,
  pageSize = 100,
  maxItems = 100,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined = undefined;
  const MAX_PAGES = 20;
  // Gmail's max page size is 500
  const cappedMax = Math.min(maxItems, 500);

  for (let page = 0; page < MAX_PAGES; page++) {
    const size = Math.min(pageSize, 500, cappedMax - items.length);
    const response = await fetcher(pageToken, size);
    items.push(...response.items);

    if (items.length >= cappedMax || !response.nextPageToken || response.items.length === 0) {
      break;
    }
    pageToken = response.nextPageToken;
  }

  return items.slice(0, cappedMax);
}
