// @nodalai/adapter-firecrawl — crawl tool tests
// Mocks: @mendable/firecrawl-js FirecrawlClient methods are stubbed.
// Assertions are on real returned content / arguments passed to the SDK.

import { describe, it, expect, vi } from 'vitest';
import { createFirecrawlClient } from '../../client.ts';
import { makeFirecrawlCrawlStartTool, makeFirecrawlCrawlStatusTool } from '../../tools/crawl.ts';
import { FirecrawlApiError } from '../../errors.ts';
import type { ToolContext } from '@nodalai/tools';

vi.mock('@mendable/firecrawl-js', () => {
  return {
    FirecrawlClient: vi.fn().mockImplementation(() => ({
      scrape: vi.fn(),
      map: vi.fn(),
      search: vi.fn(),
      startCrawl: vi.fn(),
      getCrawlStatus: vi.fn(),
    })),
  };
});

// Minimal ToolContext stub — adapters don't use ctx, but the type requires it
const CTX = {} as ToolContext;

function getClient() {
  return createFirecrawlClient('fc-test-key');
}

// ── firecrawl_crawl_start ─────────────────────────────────────────────────────

describe('makeFirecrawlCrawlStartTool', () => {
  it('returns job id and url from SDK startCrawl', async () => {
    const client = getClient();
    vi.spyOn(client, 'startCrawl').mockResolvedValue({
      id: 'crawl-job-abc123',
      url: 'https://example.com',
    });

    const tool = makeFirecrawlCrawlStartTool(client);
    const result = await tool.execute({ url: 'https://example.com' }, CTX);

    expect(result.id).toBe('crawl-job-abc123');
    expect(result.url).toBe('https://example.com');
  });

  it('passes url and limit to SDK startCrawl', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'startCrawl').mockResolvedValue({
      id: 'job-xyz',
      url: 'https://example.com',
    });

    const tool = makeFirecrawlCrawlStartTool(client);
    await tool.execute({ url: 'https://example.com', limit: 50 }, CTX);

    expect(spy).toHaveBeenCalledWith('https://example.com', { limit: 50 });
  });

  it('calls SDK without limit key when limit is undefined', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'startCrawl').mockResolvedValue({
      id: 'job-xyz',
      url: 'https://example.com',
    });

    const tool = makeFirecrawlCrawlStartTool(client);
    await tool.execute({ url: 'https://example.com' }, CTX);

    expect(spy).toHaveBeenCalledWith('https://example.com', {});
  });

  it('wraps SDK errors in FirecrawlApiError', async () => {
    const client = getClient();
    vi.spyOn(client, 'startCrawl').mockRejectedValue(new Error('URL cannot be empty'));

    const tool = makeFirecrawlCrawlStartTool(client);
    await expect(tool.execute({ url: 'https://example.com' }, CTX)).rejects.toSatisfy(
      (err: unknown) => err instanceof FirecrawlApiError && err.code === 'firecrawl_unknown',
    );
  });

  it('has riskLevel read and correct name', () => {
    const tool = makeFirecrawlCrawlStartTool(getClient());
    expect(tool.name).toBe('firecrawl_crawl_start');
    expect(tool.riskLevel).toBe('read');
  });
});

// ── firecrawl_crawl_status ────────────────────────────────────────────────────

describe('makeFirecrawlCrawlStatusTool', () => {
  it('returns status, totals, and document data from SDK', async () => {
    const client = getClient();
    vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'crawl-job-abc123',
      status: 'completed',
      total: 10,
      completed: 10,
      data: [
        {
          markdown: '# Page 1',
          metadata: { url: 'https://example.com/page1' },
        },
        {
          markdown: '# Page 2',
          html: '<h1>Page 2</h1>',
          metadata: { url: 'https://example.com/page2' },
        },
      ],
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    const result = await tool.execute({ id: 'crawl-job-abc123' }, CTX);

    expect(result.id).toBe('crawl-job-abc123');
    expect(result.status).toBe('completed');
    expect(result.total).toBe(10);
    expect(result.completed).toBe(10);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({
      url: 'https://example.com/page1',
      markdown: '# Page 1',
    });
    expect(result.data[1]).toEqual({
      url: 'https://example.com/page2',
      markdown: '# Page 2',
      html: '<h1>Page 2</h1>',
    });
  });

  it('passes job id to SDK getCrawlStatus', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'job-xyz',
      status: 'scraping',
      total: 5,
      completed: 2,
      data: [],
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    await tool.execute({ id: 'job-xyz' }, CTX);

    expect(spy).toHaveBeenCalledWith('job-xyz');
  });

  it('handles in-progress scraping status correctly', async () => {
    const client = getClient();
    vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'job-in-progress',
      status: 'scraping',
      total: 20,
      completed: 7,
      data: [],
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    const result = await tool.execute({ id: 'job-in-progress' }, CTX);

    expect(result.status).toBe('scraping');
    expect(result.completed).toBe(7);
    expect(result.total).toBe(20);
    expect(result.data).toEqual([]);
  });

  it('wraps SDK errors in FirecrawlApiError', async () => {
    const client = getClient();
    vi.spyOn(client, 'getCrawlStatus').mockRejectedValue(new Error('Job not found'));

    const tool = makeFirecrawlCrawlStatusTool(client);
    await expect(tool.execute({ id: 'bad-job-id' }, CTX)).rejects.toSatisfy(
      (err: unknown) => err instanceof FirecrawlApiError && err.code === 'firecrawl_unknown',
    );
  });

  it('has riskLevel read and correct name', () => {
    const tool = makeFirecrawlCrawlStatusTool(getClient());
    expect(tool.name).toBe('firecrawl_crawl_status');
    expect(tool.riskLevel).toBe('read');
  });
});
