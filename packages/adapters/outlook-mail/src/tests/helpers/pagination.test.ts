// @nodal-agents/adapter-outlook-mail — pagination helper tests

import { describe, it, expect } from 'vitest';
import { paginateOutlook } from '../../helpers/pagination';
import type { ODataListResponse } from '../../helpers/pagination';
import type { Client } from '@microsoft/microsoft-graph-client';

interface Item {
  id: string;
}

function makeClient(getImpl: (url: string) => Promise<ODataListResponse<Item>>): Client {
  return {
    api: (url: string) => ({ get: () => getImpl(url) }),
  } as unknown as Client;
}

describe('paginateOutlook', () => {
  it('collects all items from a single page (no nextLink)', async () => {
    const client = makeClient(async () => ({ value: [{ id: 'x' }] }));
    const items = await paginateOutlook<Item>(
      client,
      async () => ({ value: [{ id: '1' }, { id: '2' }] }),
      50,
    );
    expect(items).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('follows @odata.nextLink across multiple pages, calling client.api with the full URL verbatim', async () => {
    const calls: string[] = [];
    const client = makeClient(async (url) => {
      calls.push(url);
      return { value: [{ id: 'p2-a' }] };
    });
    const items = await paginateOutlook<Item>(
      client,
      async () => ({
        value: [{ id: 'p1-a' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=1',
      }),
      50,
    );
    expect(items).toEqual([{ id: 'p1-a' }, { id: 'p2-a' }]);
    expect(calls).toEqual(['https://graph.microsoft.com/v1.0/me/messages?$skip=1']);
  });

  it('stops once maxItems is reached even if nextLink is present', async () => {
    const client = makeClient(async () => ({
      value: [{ id: 'p2-a' }, { id: 'p2-b' }],
      '@odata.nextLink': 'https://x/next2',
    }));
    const items = await paginateOutlook<Item>(
      client,
      async () => ({
        value: [{ id: 'p1-a' }, { id: 'p1-b' }],
        '@odata.nextLink': 'https://x/next1',
      }),
      3,
    );
    expect(items).toHaveLength(3);
  });

  it('stops when a page returns zero items even if nextLink is present (guards a broken loop)', async () => {
    const client = makeClient(async () => ({ value: [], '@odata.nextLink': 'https://x/next' }));
    const items = await paginateOutlook<Item>(
      client,
      async () => ({ value: [], '@odata.nextLink': 'https://x/next' }),
      50,
    );
    expect(items).toEqual([]);
  });

  it('never exceeds MAX_PAGES (20) fetches even with an infinite nextLink chain', async () => {
    let fetchCount = 0;
    const client = makeClient(async () => {
      fetchCount++;
      return { value: [{ id: `item-${fetchCount}` }], '@odata.nextLink': 'https://x/always-next' };
    });
    const items = await paginateOutlook<Item>(
      client,
      async () => {
        fetchCount++;
        return { value: [{ id: 'item-0' }], '@odata.nextLink': 'https://x/always-next' };
      },
      1000,
    );
    expect(fetchCount).toBeLessThanOrEqual(20);
    expect(items.length).toBeLessThanOrEqual(20);
  });

  it('treats a missing value array as empty rather than throwing', async () => {
    const client = makeClient(async () => ({}));
    const items = await paginateOutlook<Item>(client, async () => ({}), 50);
    expect(items).toEqual([]);
  });
});
