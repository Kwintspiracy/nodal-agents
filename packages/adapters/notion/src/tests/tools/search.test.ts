// @nodalai/adapter-notion — notion_search tool tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@notionhq/client';
import { APIResponseError, APIErrorCode } from '@notionhq/client';
import { createSearchTool } from '../../tools/search.js';
import { NotionAdapterError } from '../../errors.js';

// Minimal mock client
function makeClient(overrides: Partial<{ search: Client['search'] }> = {}): Client {
  return {
    search: vi.fn(),
    ...overrides,
  } as unknown as Client;
}

// Real Notion API response shape (from @notionhq/client types)
const pageResult = {
  object: 'page' as const,
  id: 'page-id-1',
  url: 'https://www.notion.so/page-id-1',
  properties: {
    title: {
      type: 'title',
      title: [
        {
          plain_text: 'My Page',
          annotations: {},
          href: null,
          type: 'text',
          text: { content: 'My Page', link: null },
        },
      ],
    },
  },
  created_time: '2024-01-01T00:00:00.000Z',
  last_edited_time: '2024-01-02T00:00:00.000Z',
  parent: { type: 'workspace', workspace: true },
  archived: false,
  cover: null,
  icon: null,
  in_trash: false,
  created_by: { id: 'user-1', object: 'user' },
  last_edited_by: { id: 'user-1', object: 'user' },
  public_url: null,
};

const dbResult = {
  object: 'database' as const,
  id: 'db-id-1',
  url: 'https://www.notion.so/db-id-1',
  title: [
    {
      plain_text: 'My Database',
      annotations: {},
      href: null,
      type: 'text',
      text: { content: 'My Database', link: null },
    },
  ],
  properties: {},
  created_time: '2024-01-01T00:00:00.000Z',
  last_edited_time: '2024-01-02T00:00:00.000Z',
  parent: { type: 'workspace', workspace: true },
  archived: false,
  cover: null,
  icon: null,
  in_trash: false,
  created_by: { id: 'user-1', object: 'user' },
  last_edited_by: { id: 'user-1', object: 'user' },
  description: [],
  is_inline: false,
  public_url: null,
};

describe('notion_search', () => {
  let client: Client;
  let searchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    searchFn = vi.fn();
    client = makeClient({ search: searchFn });
  });

  it('returns results with id, title, url, object', async () => {
    searchFn.mockResolvedValueOnce({
      results: [pageResult, dbResult],
      has_more: false,
      next_cursor: null,
      object: 'list',
      type: 'page_or_database',
      page_or_database: {},
    });

    const tool = createSearchTool(client);
    const result = await tool.execute({ query: 'test', limit: 10 }, {} as never);

    expect(result.total).toBe(2);
    expect(result.results[0]).toMatchObject({
      object: 'page',
      id: 'page-id-1',
      title: 'My Page',
      url: 'https://www.notion.so/page-id-1',
    });
    expect(result.results[1]).toMatchObject({
      object: 'database',
      id: 'db-id-1',
      title: 'My Database',
    });
  });

  it('passes query and page_size to the SDK', async () => {
    searchFn.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
      object: 'list',
      type: 'page_or_database',
      page_or_database: {},
    });

    const tool = createSearchTool(client);
    await tool.execute({ query: 'hello', limit: 5 }, {} as never);

    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'hello', page_size: 5 }),
    );
  });

  it('applies filter_type when provided', async () => {
    searchFn.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
      object: 'list',
      type: 'page_or_database',
      page_or_database: {},
    });

    const tool = createSearchTool(client);
    await tool.execute({ query: 'docs', limit: 10, filter_type: 'database' }, {} as never);

    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { property: 'object', value: 'database' },
      }),
    );
  });

  it('maps 401 API error to notion_unauthorized', async () => {
    const apiError = new APIResponseError({
      status: 401,
      headers: {} as Headers,
      rawBodyText: 'Unauthorized',
      code: APIErrorCode.Unauthorized,
      message: 'API token is invalid.',
    });
    searchFn.mockRejectedValueOnce(apiError);

    const tool = createSearchTool(client);
    await expect(tool.execute({ query: 'x', limit: 10 }, {} as never)).rejects.toMatchObject({
      code: 'notion_unauthorized',
    });
  });

  it('maps 404 API error to notion_not_found', async () => {
    const apiError = new APIResponseError({
      status: 404,
      headers: {} as Headers,
      rawBodyText: 'Not found',
      code: APIErrorCode.ObjectNotFound,
      message: 'Not found.',
    });
    searchFn.mockRejectedValueOnce(apiError);

    const tool = createSearchTool(client);
    await expect(tool.execute({ query: 'x', limit: 10 }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('maps 429 API error to notion_rate_limited', async () => {
    const apiError = new APIResponseError({
      status: 429,
      headers: {} as Headers,
      rawBodyText: 'Rate limited',
      code: APIErrorCode.RateLimited,
      message: 'Rate limited.',
    });
    searchFn.mockRejectedValueOnce(apiError);

    const tool = createSearchTool(client);
    await expect(tool.execute({ query: 'x', limit: 10 }, {} as never)).rejects.toBeInstanceOf(
      NotionAdapterError,
    );
  });

  it('returns empty results when no matches', async () => {
    searchFn.mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
      object: 'list',
      type: 'page_or_database',
      page_or_database: {},
    });

    const tool = createSearchTool(client);
    const result = await tool.execute({ query: 'no-match', limit: 10 }, {} as never);
    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('has name notion_search and riskLevel read', () => {
    const tool = createSearchTool(client);
    expect(tool.name).toBe('notion_search');
    expect(tool.riskLevel).toBe('read');
  });
});
