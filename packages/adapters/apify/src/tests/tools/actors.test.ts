// @nodal-agents/adapter-apify — actors tools unit tests
// Mocks the apify-client SDK module surface. Asserts on real returned content
// and arguments passed to the SDK — not just call counts.

import { describe, it, expect, vi } from 'vitest';
import { ApifyApiError } from '../../errors.ts';
import {
  makeApifyWebBrowseTool,
  makeApifyRunActorTool,
  makeApifyGetRunTool,
} from '../../tools/actors.ts';
import type { ApifyClient } from '../../client.ts';
import type { ToolContext } from '@nodal-agents/tools';

// Minimal ToolContext stub — adapter tools do not use ctx fields
const ctx = {} as ToolContext;

// ── Shared mock factory ────────────────────────────────────────────────────────

function makeRunResult(
  overrides: Partial<{
    id: string;
    defaultDatasetId: string;
    status: string;
  }> = {},
) {
  return {
    id: overrides.id ?? 'run-abc-123',
    actId: 'actor-id-xyz',
    status: overrides.status ?? 'SUCCEEDED',
    defaultDatasetId: overrides.defaultDatasetId ?? 'dataset-abc-123',
    defaultKeyValueStoreId: 'kvs-abc-123',
    startedAt: new Date('2024-01-01T10:00:00Z'),
    finishedAt: new Date('2024-01-01T10:05:00Z'),
  };
}

function makeClient(
  overrides: {
    actorCall?: ReturnType<typeof vi.fn>;
    runGet?: ReturnType<typeof vi.fn>;
  } = {},
): ApifyClient {
  const actorCall = overrides.actorCall ?? vi.fn().mockResolvedValue(makeRunResult());
  const runGet = overrides.runGet ?? vi.fn().mockResolvedValue(makeRunResult());

  return {
    actor: vi.fn().mockReturnValue({ call: actorCall }),
    run: vi.fn().mockReturnValue({ get: runGet }),
  } as unknown as ApifyClient;
}

// ── apify_run_actor ───────────────────────────────────────────────────────────

describe('makeApifyRunActorTool', () => {
  it('tool name is apify_run_actor', () => {
    const tool = makeApifyRunActorTool(makeClient());
    expect(tool.name).toBe('apify_run_actor');
  });

  it('riskLevel is write', () => {
    const tool = makeApifyRunActorTool(makeClient());
    expect(tool.riskLevel).toBe('write');
  });

  it('inputSchema requires actorId, input is optional', () => {
    const tool = makeApifyRunActorTool(makeClient());
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ actorId: 'apify/web-scraper' })).not.toThrow();
    expect(() =>
      tool.inputSchema.parse({ actorId: 'apify/web-scraper', input: { startUrls: [] } }),
    ).not.toThrow();
  });

  it('calls client.actor(actorId).call(input) with correct arguments', async () => {
    const actorCall = vi.fn().mockResolvedValue(makeRunResult());
    const actorFn = vi.fn().mockReturnValue({ call: actorCall });
    const client = { actor: actorFn } as unknown as ApifyClient;
    const tool = makeApifyRunActorTool(client);

    await tool.execute(
      { actorId: 'apify/web-scraper', input: { url: 'https://example.com' } },
      ctx,
    );

    expect(actorFn).toHaveBeenCalledWith('apify/web-scraper');
    expect(actorCall).toHaveBeenCalledWith({ url: 'https://example.com' });
  });

  it('calls client.actor(actorId).call(undefined) when input is omitted', async () => {
    const actorCall = vi.fn().mockResolvedValue(makeRunResult());
    const actorFn = vi.fn().mockReturnValue({ call: actorCall });
    const client = { actor: actorFn } as unknown as ApifyClient;
    const tool = makeApifyRunActorTool(client);

    await tool.execute({ actorId: 'apify/web-scraper' }, ctx);

    expect(actorCall).toHaveBeenCalledWith(undefined);
  });

  it('returns runId, datasetId, and status from the run result', async () => {
    const runData = makeRunResult({
      id: 'run-xyz',
      defaultDatasetId: 'ds-xyz',
      status: 'SUCCEEDED',
    });
    const client = makeClient({ actorCall: vi.fn().mockResolvedValue(runData) });
    const tool = makeApifyRunActorTool(client);

    const result = await tool.execute({ actorId: 'apify/web-scraper' }, ctx);

    expect(result.runId).toBe('run-xyz');
    expect(result.datasetId).toBe('ds-xyz');
    expect(result.status).toBe('SUCCEEDED');
  });

  it('wraps SDK errors into ApifyApiError', async () => {
    const sdkErr = { statusCode: 403, message: 'Forbidden' };
    const client = makeClient({ actorCall: vi.fn().mockRejectedValue(sdkErr) });
    const tool = makeApifyRunActorTool(client);

    await expect(tool.execute({ actorId: 'apify/web-scraper' }, ctx)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApifyApiError && err.code === 'apify_forbidden' && err.status === 403,
    );
  });

  it('wraps network Error into apify_unknown', async () => {
    const client = makeClient({
      actorCall: vi.fn().mockRejectedValue(new Error('Network timeout')),
    });
    const tool = makeApifyRunActorTool(client);

    await expect(tool.execute({ actorId: 'apify/web-scraper' }, ctx)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApifyApiError && err.code === 'apify_unknown',
    );
  });
});

// ── apify_get_run ─────────────────────────────────────────────────────────────

describe('makeApifyGetRunTool', () => {
  it('tool name is apify_get_run', () => {
    const tool = makeApifyGetRunTool(makeClient());
    expect(tool.name).toBe('apify_get_run');
  });

  it('riskLevel is read', () => {
    const tool = makeApifyGetRunTool(makeClient());
    expect(tool.riskLevel).toBe('read');
  });

  it('inputSchema requires runId', () => {
    const tool = makeApifyGetRunTool(makeClient());
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ runId: 'run-abc-123' })).not.toThrow();
  });

  it('calls client.run(runId).get() with correct argument', async () => {
    const runGet = vi.fn().mockResolvedValue(makeRunResult());
    const runFn = vi.fn().mockReturnValue({ get: runGet });
    const client = { run: runFn } as unknown as ApifyClient;
    const tool = makeApifyGetRunTool(client);

    await tool.execute({ runId: 'run-abc-123' }, ctx);

    expect(runFn).toHaveBeenCalledWith('run-abc-123');
    expect(runGet).toHaveBeenCalled();
  });

  it('returns mapped run metadata with ISO date strings', async () => {
    const runData = makeRunResult({ id: 'run-abc-123', status: 'SUCCEEDED' });
    const client = makeClient({ runGet: vi.fn().mockResolvedValue(runData) });
    const tool = makeApifyGetRunTool(client);

    const result = await tool.execute({ runId: 'run-abc-123' }, ctx);

    expect(result.id).toBe('run-abc-123');
    expect(result.actId).toBe('actor-id-xyz');
    expect(result.status).toBe('SUCCEEDED');
    expect(result.defaultDatasetId).toBe('dataset-abc-123');
    expect(result.defaultKeyValueStoreId).toBe('kvs-abc-123');
    expect(result.startedAt).toBe('2024-01-01T10:00:00.000Z');
    expect(result.finishedAt).toBe('2024-01-01T10:05:00.000Z');
  });

  it('returns null dates when startedAt/finishedAt are absent', async () => {
    const runData = {
      id: 'run-no-dates',
      actId: 'actor-id',
      status: 'RUNNING',
      defaultDatasetId: 'ds-id',
      defaultKeyValueStoreId: 'kvs-id',
      startedAt: null as unknown as Date,
      finishedAt: null as unknown as Date,
    };
    const client = makeClient({ runGet: vi.fn().mockResolvedValue(runData) });
    const tool = makeApifyGetRunTool(client);

    const result = await tool.execute({ runId: 'run-no-dates' }, ctx);

    expect(result.startedAt).toBeNull();
    expect(result.finishedAt).toBeNull();
  });

  it('throws apify_not_found when SDK returns undefined (run not found)', async () => {
    const client = makeClient({ runGet: vi.fn().mockResolvedValue(undefined) });
    const tool = makeApifyGetRunTool(client);

    await expect(tool.execute({ runId: 'nonexistent-run' }, ctx)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApifyApiError && err.code === 'apify_not_found',
    );
  });

  it('wraps SDK errors into ApifyApiError', async () => {
    const sdkErr = { statusCode: 404, message: 'Run not found' };
    const client = makeClient({ runGet: vi.fn().mockRejectedValue(sdkErr) });
    const tool = makeApifyGetRunTool(client);

    await expect(tool.execute({ runId: 'run-abc-123' }, ctx)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApifyApiError && err.code === 'apify_not_found' && err.status === 404,
    );
  });
});

// ── apify_web_browse ──────────────────────────────────────────────────────────

describe('makeApifyWebBrowseTool', () => {
  // A client whose actor(...).call() and dataset(...).listItems() are mockable.
  function makeBrowseClient(
    items: unknown[],
    overrides: { actorCall?: ReturnType<typeof vi.fn>; listItems?: ReturnType<typeof vi.fn> } = {},
  ) {
    const actorCall =
      overrides.actorCall ??
      vi.fn().mockResolvedValue({ id: 'run-1', defaultDatasetId: 'ds-1', status: 'SUCCEEDED' });
    const listItems =
      overrides.listItems ??
      vi.fn().mockResolvedValue({ items, total: items.length, count: items.length, offset: 0 });
    const actorFn = vi.fn().mockReturnValue({ call: actorCall });
    const datasetFn = vi.fn().mockReturnValue({ listItems });
    const client = { actor: actorFn, dataset: datasetFn } as unknown as ApifyClient;
    return { client, actorFn, actorCall, datasetFn, listItems };
  }

  it('tool name is apify_web_browse and riskLevel is read', () => {
    const { client } = makeBrowseClient([]);
    const tool = makeApifyWebBrowseTool(client);
    expect(tool.name).toBe('apify_web_browse');
    expect(tool.riskLevel).toBe('read');
  });

  it('inputSchema requires a non-empty query; maxResults optional', () => {
    const { client } = makeBrowseClient([]);
    const tool = makeApifyWebBrowseTool(client);
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ query: '' })).toThrow();
    expect(() => tool.inputSchema.parse({ query: 'https://x.com' })).not.toThrow();
    expect(() => tool.inputSchema.parse({ query: 'ux jobs', maxResults: 5 })).not.toThrow();
  });

  it('runs rag-web-browser then reads its dataset INLINE (one call, no poll handle)', async () => {
    const { client, actorFn, actorCall, datasetFn, listItems } = makeBrowseClient([
      { metadata: { url: 'https://a.com', title: 'A' }, markdown: '# A page' },
    ]);
    const tool = makeApifyWebBrowseTool(client);

    const out = await tool.execute({ query: 'https://a.com' }, ctx);

    // It targets rag-web-browser specifically, blocking-calls it, and reads the run's dataset.
    expect(actorFn).toHaveBeenCalledWith('apify/rag-web-browser');
    expect(actorCall).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'https://a.com', outputFormats: ['text'] }),
    );
    expect(datasetFn).toHaveBeenCalledWith('ds-1'); // the run's own dataset
    expect(listItems).toHaveBeenCalled();
    // Real result content, not a run handle.
    expect(out).toEqual({
      query: 'https://a.com',
      count: 1,
      results: [{ url: 'https://a.com', title: 'A', content: '# A page' }],
    });
  });

  it('normalizes varied item shapes (searchResult / crawl / text fallback)', async () => {
    const { client } = makeBrowseClient([
      { searchResult: { url: 'https://s.com', title: 'S' }, text: 'plain text' },
      { crawl: { loadedUrl: 'https://c.com' }, markdown: 'md body' },
      { metadata: { url: 'https://empty.com' } }, // no content → filtered out
    ]);
    const tool = makeApifyWebBrowseTool(client);

    const out = await tool.execute({ query: 'designer jobs', maxResults: 3 }, ctx);

    expect(out.count).toBe(2); // the contentless item is dropped
    expect(out.results).toEqual([
      { url: 'https://s.com', title: 'S', content: 'plain text' },
      { url: 'https://c.com', title: '', content: 'md body' },
    ]);
  });

  it('defaults maxResults to 3 when omitted', async () => {
    const { client, actorCall } = makeBrowseClient([]);
    const tool = makeApifyWebBrowseTool(client);
    await tool.execute({ query: 'jobs' }, ctx);
    expect(actorCall).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 3 }));
  });

  it('requests text output (the proven format), not markdown', async () => {
    const { client, actorCall } = makeBrowseClient([]);
    const tool = makeApifyWebBrowseTool(client);
    await tool.execute({ query: 'https://a.com' }, ctx);
    expect(actorCall).toHaveBeenCalledWith(expect.objectContaining({ outputFormats: ['text'] }));
  });

  it('strips control characters from scraped content (keeps tab + newline)', async () => {
    // Build a dirty string without typing literal control chars in source.
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const TAB = String.fromCharCode(9);
    const LF = String.fromCharCode(10);
    const dirty = `clean${NUL}${BEL}text${TAB}kept${LF}line`;
    const { client } = makeBrowseClient([
      { metadata: { url: 'https://x.com', title: 'X' }, text: dirty },
    ]);
    const tool = makeApifyWebBrowseTool(client);

    const out = await tool.execute({ query: 'https://x.com' }, ctx);

    // NUL + BEL removed; tab + newline preserved → transport-safe content.
    expect(out.results[0]?.content).toBe(`cleantext${TAB}kept${LF}line`);
  });

  it('wraps SDK errors into ApifyApiError', async () => {
    const { client } = makeBrowseClient([], {
      actorCall: vi.fn().mockRejectedValue({ statusCode: 403, message: 'forbidden' }),
    });
    const tool = makeApifyWebBrowseTool(client);
    await expect(tool.execute({ query: 'x' }, ctx)).rejects.toSatisfy(
      (err: unknown) => err instanceof ApifyApiError && err.status === 403,
    );
  });
});
