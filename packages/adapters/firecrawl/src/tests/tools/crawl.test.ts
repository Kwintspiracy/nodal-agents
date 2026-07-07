// @nodal-agents/adapter-firecrawl — crawl tool tests
// Mocks: @mendable/firecrawl-js FirecrawlClient methods are stubbed.
// Assertions are on real returned content / arguments passed to the SDK.

import { describe, it, expect, vi } from 'vitest';
import { createFirecrawlClient } from '../../client.ts';
import { makeFirecrawlCrawlStartTool, makeFirecrawlCrawlStatusTool } from '../../tools/crawl.ts';
import { FirecrawlApiError } from '../../errors.ts';
import type { ToolContext } from '@nodal-agents/tools';

vi.mock('@mendable/firecrawl-js', () => {
  // Vitest 4 stopped accepting `vi.fn().mockImplementation(() => ({...}))` as
  // a constructor (instantiating via `new` throws). We use a real class so
  // `new FirecrawlClient(...)` works at runtime.
  class FirecrawlClient {
    scrape = vi.fn();
    map = vi.fn();
    search = vi.fn();
    startCrawl = vi.fn();
    getCrawlStatus = vi.fn();
  }
  return { FirecrawlClient };
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
      truncated: false,
    });
    expect(result.data[1]).toEqual({
      url: 'https://example.com/page2',
      markdown: '# Page 2',
      html: '<h1>Page 2</h1>',
      truncated: false,
    });
  });

  // audit#2 F-17: markdown must be capped like gmail/drive/notion fields —
  // before the fix there was no cap at all, so this would have failed (no
  // truncation, full-length markdown, no truncated flag).
  it('caps a document markdown at 15000 chars and sets truncated:true when huge', async () => {
    const client = getClient();
    const hugeMarkdown = '# '.repeat(10_000); // 20,000 chars
    vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'crawl-job-huge',
      status: 'completed',
      total: 1,
      completed: 1,
      data: [{ markdown: hugeMarkdown, metadata: { url: 'https://big.example.com' } }],
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    const result = await tool.execute({ id: 'crawl-job-huge' }, CTX);

    expect(result.data[0]?.truncated).toBe(true);
    expect(result.data[0]?.markdown?.length).toBeLessThan(hugeMarkdown.length);
    expect(result.data[0]?.markdown).toContain('[...content truncated at 15000 chars...]');
  });

  // audit#2 F-17 (regression follow-up): html is typically larger than
  // markdown for the same page — must be capped too, not just markdown.
  it('caps a document html at 15000 chars and sets truncated:true when huge', async () => {
    const client = getClient();
    const hugeHtml = '<p>x</p>'.repeat(3000); // 24,000 chars
    vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'crawl-job-huge-html',
      status: 'completed',
      total: 1,
      completed: 1,
      data: [{ html: hugeHtml, metadata: { url: 'https://big.example.com' } }],
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    const result = await tool.execute({ id: 'crawl-job-huge-html' }, CTX);

    expect(result.data[0]?.truncated).toBe(true);
    expect(result.data[0]?.html?.length).toBeLessThan(hugeHtml.length);
    expect(result.data[0]?.html).toContain('[...content truncated at 15000 chars...]');
  });

  // audit#2026-07-07 F9: capField bounds each document's markdown/html, but
  // nothing bounded the NUMBER of documents in one status poll — this must
  // be capped too, with a dataTruncated flag distinct from the per-doc one.
  it('caps the number of documents at 50 per call and sets dataTruncated:true', async () => {
    const client = getClient();
    const manyDocs = Array.from({ length: 120 }, (_, i) => ({
      markdown: `# Page ${i}`,
      metadata: { url: `https://example.com/page${i}` },
    }));
    vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'crawl-job-many',
      status: 'completed',
      total: 120,
      completed: 120,
      data: manyDocs,
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    const result = await tool.execute({ id: 'crawl-job-many' }, CTX);

    expect(result.dataTruncated).toBe(true);
    expect(result.data).toHaveLength(50);
    expect(result.data[0]?.url).toBe('https://example.com/page0');
    expect(result.data[49]?.url).toBe('https://example.com/page49');
    // total/completed still reflect the real job counts — only the returned
    // page slice is capped, the job metadata is not lied about.
    expect(result.total).toBe(120);
    expect(result.completed).toBe(120);
  });

  it('does not set dataTruncated when document count is within the cap', async () => {
    const client = getClient();
    vi.spyOn(client, 'getCrawlStatus').mockResolvedValue({
      id: 'crawl-job-small',
      status: 'completed',
      total: 2,
      completed: 2,
      data: [
        { markdown: '# Page 1', metadata: { url: 'https://example.com/page1' } },
        { markdown: '# Page 2', metadata: { url: 'https://example.com/page2' } },
      ],
    });

    const tool = makeFirecrawlCrawlStatusTool(client);
    const result = await tool.execute({ id: 'crawl-job-small' }, CTX);

    expect(result.dataTruncated).toBe(false);
    expect(result.data).toHaveLength(2);
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
