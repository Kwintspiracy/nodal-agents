// @nodalai/adapter-notion — page tools tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@notionhq/client';
import { APIResponseError, APIErrorCode } from '@notionhq/client';
import {
  createGetPageTool,
  createGetPageContentTool,
  createCreatePageTool,
  createUpdatePageTool,
  createArchivePageTool,
} from '../../tools/pages';

function makeClient(methods: Partial<Record<string, unknown>> = {}): Client {
  return {
    pages: {
      retrieve: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    databases: {
      retrieve: vi.fn(),
    },
    blocks: {
      children: {
        list: vi.fn(),
      },
    },
    ...methods,
  } as unknown as Client;
}

const fakePage = {
  object: 'page',
  id: 'page-1',
  url: 'https://notion.so/page-1',
  created_time: '2024-01-01T00:00:00.000Z',
  last_edited_time: '2024-01-02T00:00:00.000Z',
  parent: { type: 'workspace', workspace: true },
  archived: false,
  properties: {
    title: {
      type: 'title',
      title: [{ plain_text: 'Test Page' }],
    },
    Status: {
      type: 'select',
      select: { name: 'Active' },
    },
  },
};

function makeApiError(status: number) {
  return new APIResponseError({
    status,
    headers: {} as Headers,
    rawBodyText: 'error',
    code: APIErrorCode.InternalServerError,
    message: `Error ${status}`,
  });
}

// ── notion_get_page ───────────────────────────────────────────────────────────

describe('notion_get_page', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns page metadata and properties', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePage);

    const tool = createGetPageTool(client);
    const result = await tool.execute({ page_id: 'page-1' }, {} as never);

    expect(result.id).toBe('page-1');
    expect(result.title).toBe('Test Page');
    expect(result.url).toBe('https://notion.so/page-1');
    expect(result.properties['Status']).toBe('Active');
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createGetPageTool(client);
    await expect(tool.execute({ page_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_unauthorized',
    });
  });

  it('maps 404 to notion_not_found', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));

    const tool = createGetPageTool(client);
    await expect(tool.execute({ page_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetPageTool(client).riskLevel).toBe('read');
  });
});

// ── notion_get_page_content ───────────────────────────────────────────────────

describe('notion_get_page_content', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns page title and content from blocks', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePage);
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        {
          object: 'block',
          id: 'block-1',
          type: 'paragraph',
          has_children: false,
          paragraph: {
            rich_text: [
              {
                plain_text: 'Hello world',
                annotations: {},
                href: null,
                type: 'text',
                text: { content: 'Hello world', link: null },
              },
            ],
          },
        },
        {
          object: 'block',
          id: 'block-2',
          type: 'heading_1',
          has_children: false,
          heading_1: {
            rich_text: [
              {
                plain_text: 'Section Title',
                annotations: {},
                href: null,
                type: 'text',
                text: { content: 'Section Title', link: null },
              },
            ],
            is_toggleable: false,
            color: 'default',
          },
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    const tool = createGetPageContentTool(client);
    const result = await tool.execute({ page_id: 'page-1', max_blocks: 300 }, {} as never);

    expect(result.title).toBe('Test Page');
    expect(result.content).toContain('Hello world');
    expect(result.content).toContain('# Section Title');
    expect(result.block_count).toBe(2);
  });

  it('returns empty content message when page has no blocks', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakePage);
    (client.blocks.children.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const tool = createGetPageContentTool(client);
    const result = await tool.execute({ page_id: 'page-1', max_blocks: 300 }, {} as never);

    expect(result.content).toBe('(no extractable text content)');
    expect(result.block_count).toBe(0);
  });

  it('maps 429 to notion_rate_limited', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(429));

    const tool = createGetPageContentTool(client);
    await expect(
      tool.execute({ page_id: 'x', max_blocks: 300 }, {} as never),
    ).rejects.toMatchObject({
      code: 'notion_rate_limited',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetPageContentTool(client).riskLevel).toBe('read');
  });
});

// ── notion_create_page ────────────────────────────────────────────────────────

describe('notion_create_page', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('creates a page under a parent page', async () => {
    (client.pages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'new-page-1',
      url: 'https://notion.so/new-page-1',
      object: 'page',
    });

    const tool = createCreatePageTool(client);
    const result = await tool.execute(
      { parent_page_id: 'parent-1', title: 'New Page', content: 'Some text' },
      {} as never,
    );

    expect(result.id).toBe('new-page-1');
    expect(result.url).toBe('https://notion.so/new-page-1');
    expect(result.title).toBe('New Page');
  });

  it('throws when both parent_page_id and parent_database_id provided', async () => {
    const tool = createCreatePageTool(client);
    await expect(
      tool.execute({ parent_page_id: 'p1', parent_database_id: 'db1', title: 'X' }, {} as never),
    ).rejects.toMatchObject({ code: 'notion_unknown' });
  });

  it('throws when neither parent provided', async () => {
    const tool = createCreatePageTool(client);
    await expect(tool.execute({ title: 'Orphan' }, {} as never)).rejects.toMatchObject({
      code: 'notion_unknown',
    });
  });

  it('discovers title property name from database schema', async () => {
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'db-1',
      properties: {
        Name: { type: 'title' },
        Status: { type: 'select' },
      },
    });
    (client.pages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'new-row-1',
      url: 'https://notion.so/new-row-1',
      object: 'page',
    });

    const tool = createCreatePageTool(client);
    await tool.execute({ parent_database_id: 'db-1', title: 'New Row' }, {} as never);

    const createCall = (client.pages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      properties: Record<string, unknown>;
    };
    expect(createCall.properties).toHaveProperty('Name');
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.pages.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createCreatePageTool(client);
    await expect(
      tool.execute({ parent_page_id: 'p1', title: 'Fail' }, {} as never),
    ).rejects.toMatchObject({ code: 'notion_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createCreatePageTool(client).riskLevel).toBe('write');
  });
});

// ── notion_update_page ────────────────────────────────────────────────────────

describe('notion_update_page', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('calls pages.update with coerced properties', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...fakePage,
      parent: { type: 'database_id', database_id: 'db-1' },
    });
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'db-1',
      properties: {
        Status: { type: 'select' },
        Score: { type: 'number' },
      },
    });
    (client.pages.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'page-1' });

    const tool = createUpdatePageTool(client);
    const result = await tool.execute(
      { page_id: 'page-1', properties: { Status: 'Done', Score: 95 } },
      {} as never,
    );

    expect(result.id).toBe('page-1');
    expect(result.updated_properties).toBe(2);
    expect(client.pages.update).toHaveBeenCalledOnce();
  });

  it('maps 404 to notion_not_found', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));
    (client.pages.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(404));

    const tool = createUpdatePageTool(client);
    await expect(
      tool.execute({ page_id: 'missing', properties: { x: 'y' } }, {} as never),
    ).rejects.toMatchObject({ code: 'notion_not_found' });
  });

  it('has riskLevel write', () => {
    expect(createUpdatePageTool(client).riskLevel).toBe('write');
  });
});

// ── notion_archive_page ───────────────────────────────────────────────────────

describe('notion_archive_page', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('calls pages.update with archived: true', async () => {
    (client.pages.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'page-1',
      archived: true,
    });

    const tool = createArchivePageTool(client);
    const result = await tool.execute({ page_id: 'page-1' }, {} as never);

    expect(result.id).toBe('page-1');
    expect(result.archived).toBe(true);
    expect(client.pages.update).toHaveBeenCalledWith({
      page_id: 'page-1',
      archived: true,
    });
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.pages.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createArchivePageTool(client);
    await expect(tool.execute({ page_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_unauthorized',
    });
  });

  it('has riskLevel destructive', () => {
    expect(createArchivePageTool(client).riskLevel).toBe('destructive');
  });
});
