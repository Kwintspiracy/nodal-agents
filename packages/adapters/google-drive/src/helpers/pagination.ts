// @nodal-agents/adapter-google-drive — pagination helper for Drive's pageToken API

/**
 * Paginate a Drive list endpoint by following `nextPageToken`.
 *
 * @param fetcher  - Function that accepts (pageToken | undefined, pageSize) and returns
 *                   a Drive list response with `items`, `nextPageToken`.
 * @param pageSize - Items per page request (max 1000 per Drive limits).
 * @param maxItems - Hard ceiling on total items collected (default 100, max 1000).
 * @returns        Flat array of all collected items.
 *
 * Guard: max 20 page fetches to prevent runaway loops (20 × 100 = 2000 max items).
 */
export async function paginateDrive<T>(
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
  const cappedMax = Math.min(maxItems, 1000);

  for (let page = 0; page < MAX_PAGES; page++) {
    const size = Math.min(pageSize, 1000, cappedMax - items.length);
    const response = await fetcher(pageToken, size);
    items.push(...response.items);

    if (items.length >= cappedMax || !response.nextPageToken || response.items.length === 0) {
      break;
    }
    pageToken = response.nextPageToken;
  }

  return items.slice(0, cappedMax);
}
