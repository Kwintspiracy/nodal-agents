// @nodal-agents/adapter-outlook-mail — pagination helper for Graph's @odata.nextLink
//
// Unlike Gmail's pageToken (an opaque continuation token re-supplied to the
// SAME list call alongside a fresh page size — see adapter-gmail's
// paginateGmail), Graph returns a full absolute URL in `@odata.nextLink` that
// already encodes $top/$skip for the next page. The Graph SDK's
// `client.api(url)` accepts that absolute URL directly (GraphRequest strips
// the https://host/version prefix itself), so paging past the first page is
// just "call the nextLink verbatim".

import type { Client } from '@microsoft/microsoft-graph-client';

export interface ODataListResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

/**
 * Page through a Graph list endpoint by following `@odata.nextLink`.
 *
 * @param client       - The Graph client, used to fetch subsequent pages via nextLink.
 * @param firstRequest - Builds and executes the FIRST page request (caller applies
 *                       $filter/$search/$select/$top there); subsequent pages are
 *                       fetched by calling `client.api(nextLink).get()` verbatim.
 * @param maxItems     - Hard ceiling on total items collected (default 50, max 500).
 * @returns            Flat array of all collected items.
 */
export async function paginateOutlook<T>(
  client: Client,
  firstRequest: () => Promise<ODataListResponse<T>>,
  maxItems = 50,
): Promise<T[]> {
  const items: T[] = [];
  // Guard against a runaway loop, mirroring adapter-gmail's paginateGmail.
  const MAX_PAGES = 20;
  const cappedMax = Math.min(maxItems, 500);

  let nextLink: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: ODataListResponse<T> =
      page === 0
        ? await firstRequest()
        : ((await client.api(nextLink!).get()) as ODataListResponse<T>);

    const pageItems = res.value ?? [];
    items.push(...pageItems);

    nextLink = res['@odata.nextLink'];
    if (items.length >= cappedMax || !nextLink || pageItems.length === 0) break;
  }

  return items.slice(0, cappedMax);
}
