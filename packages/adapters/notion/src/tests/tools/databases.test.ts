// @nodalai/adapter-notion — database tools tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@notionhq/client';
import { APIResponseError, APIErrorCode } from '@notionhq/client';
import {
  createQueryDatabaseTool,
  createGetDatabaseTool,
  createCreateDatabaseEntryTool,
  createUpdateDatabaseEntryTool,
  createCreateDatabaseTool,
  createUpdateDatabaseTool,
} from '../../tools/databases';

function makeClient(): Client {
  return {
    databases: {
      query: vi.fn(),
      retrieve: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    pages: {
      retrieve: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as Client;
}

function makeApiError(status: number) {
  return new APIResponseError({
    status,
    headers: {} as Headers,
    rawBodyText: 'error',
    code: APIErrorCode.InternalServerError,
    message: `Error ${status}`,
  });
}

const fakeDbRow = {
  object: 'page',
  id: 'row-1',
  url: 'https://notion.so/row-1',
  properties: {
    Name: {
      type: 'title',
      title: [{ plain_text: 'Acme Corp' }],
    },
    Status: {
      type: 'select',
      select: { name: 'Applied' },
    },
  },
};

// ── notion_query_database ─────────────────────────────────────────────────────

describe('notion_query_database', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns rows with extracted properties', async () => {
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [fakeDbRow],
      has_more: false,
      next_cursor: null,
    });

    const tool = createQueryDatabaseTool(client);
    const result = await tool.execute(
      { database_id: 'db-1', page_size: 50, max_rows: 500 },
      {} as never,
    );

    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      id: 'row-1',
      url: 'https://notion.so/row-1',
      Name: 'Acme Corp',
      Status: 'Applied',
    });
  });

  it('paginates across multiple pages', async () => {
    (client.databases.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        results: [fakeDbRow],
        has_more: true,
        next_cursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        results: [{ ...fakeDbRow, id: 'row-2' }],
        has_more: false,
        next_cursor: null,
      });

    const tool = createQueryDatabaseTool(client);
    const result = await tool.execute(
      { database_id: 'db-1', page_size: 1, max_rows: 500 },
      {} as never,
    );

    expect(result.total).toBe(2);
    expect(client.databases.query).toHaveBeenCalledTimes(2);
  });

  it('respects max_rows ceiling', async () => {
    (client.databases.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [fakeDbRow, { ...fakeDbRow, id: 'row-2' }, { ...fakeDbRow, id: 'row-3' }],
      has_more: true,
      next_cursor: 'cursor-1',
    });

    const tool = createQueryDatabaseTool(client);
    const result = await tool.execute(
      { database_id: 'db-1', page_size: 50, max_rows: 2 },
      {} as never,
    );

    expect(result.total).toBe(2);
    expect(result.has_more).toBe(true);
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.databases.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createQueryDatabaseTool(client);
    await expect(
      tool.execute({ database_id: 'x', page_size: 50, max_rows: 500 }, {} as never),
    ).rejects.toMatchObject({ code: 'notion_unauthorized' });
  });

  it('has riskLevel read', () => {
    expect(createQueryDatabaseTool(client).riskLevel).toBe('read');
  });
});

// ── notion_get_database ───────────────────────────────────────────────────────

describe('notion_get_database', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('returns schema with columns and select options', async () => {
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'db-1',
      url: 'https://notion.so/db-1',
      title: [{ plain_text: 'Jobs DB' }],
      properties: {
        Name: { type: 'title' },
        Status: {
          type: 'select',
          select: { options: [{ name: 'Applied' }, { name: 'Rejected' }] },
        },
        Score: { type: 'number' },
      },
    });

    const tool = createGetDatabaseTool(client);
    const result = await tool.execute({ database_id: 'db-1' }, {} as never);

    expect(result.id).toBe('db-1');
    expect(result.title).toBe('Jobs DB');
    const statusCol = result.columns.find((c) => c.name === 'Status');
    expect(statusCol?.type).toBe('select');
    expect(statusCol?.options).toContain('Applied');
  });

  it('maps 404 to notion_not_found', async () => {
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      makeApiError(404),
    );

    const tool = createGetDatabaseTool(client);
    await expect(tool.execute({ database_id: 'x' }, {} as never)).rejects.toMatchObject({
      code: 'notion_not_found',
    });
  });

  it('has riskLevel read', () => {
    expect(createGetDatabaseTool(client).riskLevel).toBe('read');
  });
});

// ── notion_create_database_entry ──────────────────────────────────────────────

describe('notion_create_database_entry', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('creates a row and returns id and url', async () => {
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'db-1',
      properties: {
        Name: { type: 'title' },
        Status: { type: 'select' },
      },
    });
    (client.pages.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'row-new',
      url: 'https://notion.so/row-new',
      object: 'page',
    });

    const tool = createCreateDatabaseEntryTool(client);
    const result = await tool.execute(
      { database_id: 'db-1', properties: { Name: 'Acme', Status: 'Applied' } },
      {} as never,
    );

    expect(result.id).toBe('row-new');
    expect(result.url).toBe('https://notion.so/row-new');
  });

  it('maps 429 to notion_rate_limited', async () => {
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      makeApiError(429),
    );
    (client.pages.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(429));

    const tool = createCreateDatabaseEntryTool(client);
    await expect(
      tool.execute({ database_id: 'x', properties: { Name: 'test' } }, {} as never),
    ).rejects.toMatchObject({ code: 'notion_rate_limited' });
  });

  it('has riskLevel write', () => {
    expect(createCreateDatabaseEntryTool(client).riskLevel).toBe('write');
  });
});

// ── notion_update_database_entry ──────────────────────────────────────────────

describe('notion_update_database_entry', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('updates row properties', async () => {
    (client.pages.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'row-1',
      parent: { type: 'database_id', database_id: 'db-1' },
      properties: {},
    });
    (client.databases.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'db-1',
      properties: { Status: { type: 'select' } },
    });
    (client.pages.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'row-1' });

    const tool = createUpdateDatabaseEntryTool(client);
    const result = await tool.execute(
      { page_id: 'row-1', properties: { Status: 'Done' } },
      {} as never,
    );

    expect(result.id).toBe('row-1');
    expect(result.updated_properties).toBe(1);
  });

  it('has riskLevel write', () => {
    expect(createUpdateDatabaseEntryTool(client).riskLevel).toBe('write');
  });
});

// ── notion_create_database ────────────────────────────────────────────────────

describe('notion_create_database', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('creates a database with columns', async () => {
    (client.databases.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'db-new',
      url: 'https://notion.so/db-new',
    });

    const tool = createCreateDatabaseTool(client);
    const result = await tool.execute(
      {
        parent_page_id: 'page-1',
        title: 'New DB',
        columns: { Name: 'title', Status: 'select', Score: 'number' },
      },
      {} as never,
    );

    expect(result.id).toBe('db-new');
    expect(result.title).toBe('New DB');

    const createArg = (client.databases.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      properties: Record<string, unknown>;
    };
    expect(createArg.properties).toHaveProperty('Name');
    expect(createArg.properties).toHaveProperty('Status');
    expect(createArg.properties).toHaveProperty('Score');
  });

  it('maps 401 to notion_unauthorized', async () => {
    (client.databases.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makeApiError(401));

    const tool = createCreateDatabaseTool(client);
    await expect(
      tool.execute({ parent_page_id: 'x', title: 'DB', columns: { Name: 'title' } }, {} as never),
    ).rejects.toMatchObject({ code: 'notion_unauthorized' });
  });

  it('has riskLevel write', () => {
    expect(createCreateDatabaseTool(client).riskLevel).toBe('write');
  });
});

// ── notion_update_database ────────────────────────────────────────────────────

describe('notion_update_database', () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
  });

  it('updates database title', async () => {
    (client.databases.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'db-1' });

    const tool = createUpdateDatabaseTool(client);
    const result = await tool.execute({ database_id: 'db-1', title: 'New Title' }, {} as never);

    expect(result.changes).toContain('title → "New Title"');
  });

  it('adds new columns', async () => {
    (client.databases.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'db-1' });

    const tool = createUpdateDatabaseTool(client);
    const result = await tool.execute(
      { database_id: 'db-1', new_columns: { Notes: 'rich_text', Priority: 'select' } },
      {} as never,
    );

    expect(result.changes[0]).toContain('2 column(s) added');
  });

  it('throws when nothing to update', async () => {
    const tool = createUpdateDatabaseTool(client);
    await expect(tool.execute({ database_id: 'db-1' }, {} as never)).rejects.toMatchObject({
      code: 'notion_unknown',
    });
  });

  it('has riskLevel write', () => {
    expect(createUpdateDatabaseTool(client).riskLevel).toBe('write');
  });
});
