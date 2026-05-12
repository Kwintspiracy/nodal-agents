// @nodalai/adapter-apify — datasets tools unit tests
// Mocks the apify-client SDK module surface. Asserts on real returned content
// and arguments passed to the SDK — not just call counts.

import { describe, it, expect, vi } from 'vitest';
import { ApifyApiError } from '../../errors.ts';
import { makeApifyListDatasetsTool, makeApifyGetDatasetItemsTool } from '../../tools/datasets.ts';
import type { ApifyClient } from '../../client.ts';
import type { ToolContext } from '@nodalai/tools';

// Minimal ToolContext stub — adapter tools do not use ctx fields
const ctx = {} as ToolContext;

// ── Shared mock factory ────────────────────────────────────────────────────────

function makeDatasetListResult(
  overrides: Partial<{
    items: Array<{
      id: string;
      name: string | null;
      itemCount: number;
      createdAt: Date;
      modifiedAt: Date;
    }>;
    total: number;
    count: number;
    offset: number;
  }> = {},
) {
  return {
    items: overrides.items ?? [
      {
        id: 'ds-1',
        name: 'My Dataset',
        itemCount: 42,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        modifiedAt: new Date('2024-01-02T00:00:00Z'),
      },
      {
        id: 'ds-2',
        name: null,
        itemCount: 0,
        createdAt: new Date('2024-01-03T00:00:00Z'),
        modifiedAt: new Date('2024-01-04T00:00:00Z'),
      },
    ],
    total: overrides.total ?? 2,
    count: overrides.count ?? 2,
    offset: overrides.offset ?? 0,
  };
}

function makeItemsResult(
  overrides: Partial<{
    items: unknown[];
    total: number;
    count: number;
    offset: number;
  }> = {},
) {
  return {
    items: overrides.items ?? [{ url: 'https://example.com', title: 'Example' }],
    total: overrides.total ?? 1,
    count: overrides.count ?? 1,
    offset: overrides.offset ?? 0,
  };
}

function makeClient(
  overrides: {
    datasetsList?: ReturnType<typeof vi.fn>;
    datasetListItems?: ReturnType<typeof vi.fn>;
  } = {},
): ApifyClient {
  const datasetsList = overrides.datasetsList ?? vi.fn().mockResolvedValue(makeDatasetListResult());
  const datasetListItems =
    overrides.datasetListItems ?? vi.fn().mockResolvedValue(makeItemsResult());

  return {
    datasets: vi.fn().mockReturnValue({ list: datasetsList }),
    dataset: vi.fn().mockReturnValue({ listItems: datasetListItems }),
  } as unknown as ApifyClient;
}

// ── apify_list_datasets ───────────────────────────────────────────────────────

describe('makeApifyListDatasetsTool', () => {
  it('tool name is apify_list_datasets', () => {
    const tool = makeApifyListDatasetsTool(makeClient());
    expect(tool.name).toBe('apify_list_datasets');
  });

  it('riskLevel is read', () => {
    const tool = makeApifyListDatasetsTool(makeClient());
    expect(tool.riskLevel).toBe('read');
  });

  it('inputSchema accepts empty object (all params optional with defaults)', () => {
    const tool = makeApifyListDatasetsTool(makeClient());
    const parsed = tool.inputSchema.parse({}) as { limit: number; offset: number };
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(0);
  });

  it('inputSchema rejects limit > 1000', () => {
    const tool = makeApifyListDatasetsTool(makeClient());
    expect(() => tool.inputSchema.parse({ limit: 1001 })).toThrow();
  });

  it('calls client.datasets().list() with correct limit and offset', async () => {
    const datasetsList = vi.fn().mockResolvedValue(makeDatasetListResult());
    const datasetsFn = vi.fn().mockReturnValue({ list: datasetsList });
    const client = { datasets: datasetsFn } as unknown as ApifyClient;
    const tool = makeApifyListDatasetsTool(client);

    await tool.execute({ limit: 50, offset: 10 }, ctx);

    expect(datasetsFn).toHaveBeenCalled();
    expect(datasetsList).toHaveBeenCalledWith({ limit: 50, offset: 10 });
  });

  it('returns datasets array with mapped fields including null name', async () => {
    const tool = makeApifyListDatasetsTool(makeClient());
    const result = await tool.execute({ limit: 100, offset: 0 }, ctx);

    expect(result.datasets).toHaveLength(2);
    expect(result.datasets[0]).toEqual({
      id: 'ds-1',
      name: 'My Dataset',
      itemCount: 42,
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-02T00:00:00.000Z',
    });
    expect(result.datasets[1]?.name).toBeNull();
  });

  it('returns total, count, and offset from SDK response', async () => {
    const result = makeDatasetListResult({ total: 200, count: 50, offset: 100 });
    const client = makeClient({ datasetsList: vi.fn().mockResolvedValue(result) });
    const tool = makeApifyListDatasetsTool(client);

    const output = await tool.execute({ limit: 50, offset: 100 }, ctx);

    expect(output.total).toBe(200);
    expect(output.count).toBe(50);
    expect(output.offset).toBe(100);
  });

  it('wraps SDK errors into ApifyApiError', async () => {
    const sdkErr = { statusCode: 401, message: 'Unauthorized' };
    const client = makeClient({ datasetsList: vi.fn().mockRejectedValue(sdkErr) });
    const tool = makeApifyListDatasetsTool(client);

    await expect(tool.execute({ limit: 100, offset: 0 }, ctx)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApifyApiError && err.code === 'apify_unauthorized' && err.status === 401,
    );
  });
});

// ── apify_get_dataset_items ───────────────────────────────────────────────────

describe('makeApifyGetDatasetItemsTool', () => {
  it('tool name is apify_get_dataset_items', () => {
    const tool = makeApifyGetDatasetItemsTool(makeClient());
    expect(tool.name).toBe('apify_get_dataset_items');
  });

  it('riskLevel is read', () => {
    const tool = makeApifyGetDatasetItemsTool(makeClient());
    expect(tool.riskLevel).toBe('read');
  });

  it('inputSchema requires datasetId', () => {
    const tool = makeApifyGetDatasetItemsTool(makeClient());
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ datasetId: 'ds-abc' })).not.toThrow();
  });

  it('inputSchema defaults limit to 100 and offset to 0', () => {
    const tool = makeApifyGetDatasetItemsTool(makeClient());
    const parsed = tool.inputSchema.parse({ datasetId: 'ds-abc' }) as {
      limit: number;
      offset: number;
    };
    expect(parsed.limit).toBe(100);
    expect(parsed.offset).toBe(0);
  });

  it('inputSchema rejects limit > 1000', () => {
    const tool = makeApifyGetDatasetItemsTool(makeClient());
    expect(() => tool.inputSchema.parse({ datasetId: 'ds-abc', limit: 1001 })).toThrow();
  });

  it('calls client.dataset(datasetId).listItems() with correct arguments', async () => {
    const datasetListItems = vi.fn().mockResolvedValue(makeItemsResult());
    const datasetFn = vi.fn().mockReturnValue({ listItems: datasetListItems });
    const client = { dataset: datasetFn } as unknown as ApifyClient;
    const tool = makeApifyGetDatasetItemsTool(client);

    await tool.execute({ datasetId: 'ds-abc', limit: 25, offset: 50 }, ctx);

    expect(datasetFn).toHaveBeenCalledWith('ds-abc');
    expect(datasetListItems).toHaveBeenCalledWith({ limit: 25, offset: 50 });
  });

  it('returns the actual items from the dataset response', async () => {
    const itemsData = makeItemsResult({
      items: [
        { url: 'https://example.com', title: 'Page 1' },
        { url: 'https://other.com', title: 'Page 2' },
      ],
      total: 2,
      count: 2,
      offset: 0,
    });
    const client = makeClient({ datasetListItems: vi.fn().mockResolvedValue(itemsData) });
    const tool = makeApifyGetDatasetItemsTool(client);

    const result = await tool.execute({ datasetId: 'ds-abc', limit: 100, offset: 0 }, ctx);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({ url: 'https://example.com', title: 'Page 1' });
    expect(result.total).toBe(2);
    expect(result.count).toBe(2);
    expect(result.offset).toBe(0);
  });

  it('wraps SDK errors into ApifyApiError', async () => {
    const sdkErr = { statusCode: 404, message: 'Dataset not found' };
    const client = makeClient({ datasetListItems: vi.fn().mockRejectedValue(sdkErr) });
    const tool = makeApifyGetDatasetItemsTool(client);

    await expect(
      tool.execute({ datasetId: 'ds-nonexistent', limit: 100, offset: 0 }, ctx),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApifyApiError && err.code === 'apify_not_found' && err.status === 404,
    );
  });

  it('wraps rate limit error into apify_rate_limited', async () => {
    const sdkErr = { statusCode: 429, message: 'Rate limit exceeded' };
    const client = makeClient({ datasetListItems: vi.fn().mockRejectedValue(sdkErr) });
    const tool = makeApifyGetDatasetItemsTool(client);

    await expect(
      tool.execute({ datasetId: 'ds-abc', limit: 100, offset: 0 }, ctx),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApifyApiError && err.code === 'apify_rate_limited' && err.status === 429,
    );
  });
});
