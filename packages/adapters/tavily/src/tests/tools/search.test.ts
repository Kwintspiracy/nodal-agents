// @nodalai/adapter-tavily — tools/search unit tests
// Asserts on real returned content and arguments passed to the SDK.
// Never just call counts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  makeTavilySearchTool,
  makeTavilyExtractTool,
  makeTavilyCrawlTool,
} from '../../tools/search.ts';
import { TavilyApiError } from '../../errors.ts';
import type { TavilyClient } from '../../client.ts';
import type { ToolContext } from '@nodalai/tools';

// ── Shared mock client factory ────────────────────────────────────────────────

function makeClient(overrides: Partial<TavilyClient> = {}): TavilyClient {
  return {
    search: vi.fn(),
    extract: vi.fn(),
    crawl: vi.fn(),
    ...overrides,
  };
}

// Minimal ToolContext stub — adapter tools don't use ctx but the type requires it
const mockCtx = {} as ToolContext;

// ── tavily_search ─────────────────────────────────────────────────────────────

describe('makeTavilySearchTool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns tool with correct name and riskLevel', () => {
    const tool = makeTavilySearchTool(makeClient());
    expect(tool.name).toBe('tavily_search');
    expect(tool.riskLevel).toBe('read');
  });

  it('passes query and options to client.search and maps response', async () => {
    const sdkResponse = {
      query: 'best pizza NYC',
      answer: 'Joe Pizza is great.',
      results: [
        {
          title: 'Joe Pizza',
          url: 'https://joepizza.com',
          content: 'Authentic NY slice.',
          score: 0.95,
          publishedDate: '2024-03-01',
        },
      ],
      images: [{ url: 'https://example.com/img.jpg', description: 'Pizza photo' }],
      responseTime: 420,
      requestId: 'req-search-1',
    };

    const mockSearch = vi.fn().mockResolvedValueOnce(sdkResponse);
    const client = makeClient({ search: mockSearch });
    const tool = makeTavilySearchTool(client);

    const result = await tool.execute(
      {
        query: 'best pizza NYC',
        searchDepth: 'advanced',
        maxResults: 3,
        includeImages: true,
        topic: 'general',
      },
      mockCtx,
    );

    // Assert the SDK was called with the right arguments
    expect(mockSearch).toHaveBeenCalledWith('best pizza NYC', {
      searchDepth: 'advanced',
      maxResults: 3,
      includeImages: true,
      topic: 'general',
    });

    // Assert on real returned content
    expect(result.query).toBe('best pizza NYC');
    expect(result.answer).toBe('Joe Pizza is great.');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.title).toBe('Joe Pizza');
    expect(result.results[0]?.url).toBe('https://joepizza.com');
    expect(result.results[0]?.score).toBe(0.95);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.url).toBe('https://example.com/img.jpg');
    expect(result.images[0]?.description).toBe('Pizza photo');
    expect(result.responseTime).toBe(420);
  });

  it('uses default values when optional fields are omitted', async () => {
    const sdkResponse = {
      query: 'hello',
      results: [],
      images: [],
      responseTime: 100,
      requestId: 'req-2',
    };
    const mockSearch = vi.fn().mockResolvedValueOnce(sdkResponse);
    const client = makeClient({ search: mockSearch });
    const tool = makeTavilySearchTool(client);

    await tool.execute({ query: 'hello' }, mockCtx);

    // Defaults: searchDepth='basic', maxResults=5, includeImages=false, topic='general'
    expect(mockSearch).toHaveBeenCalledWith('hello', {
      searchDepth: 'basic',
      maxResults: 5,
      includeImages: false,
      topic: 'general',
    });
  });

  it('wraps SDK errors in TavilyApiError', async () => {
    const mockSearch = vi.fn().mockRejectedValueOnce(new Error('Connection refused'));
    const tool = makeTavilySearchTool(makeClient({ search: mockSearch }));

    await expect(tool.execute({ query: 'test' }, mockCtx)).rejects.toSatisfy(
      (err: unknown) => err instanceof TavilyApiError && err.code === 'tavily_unknown',
    );
  });

  it('handles empty results gracefully', async () => {
    const mockSearch = vi.fn().mockResolvedValueOnce({
      query: 'obscure topic',
      results: [],
      images: [],
      responseTime: 80,
      requestId: 'req-empty',
    });
    const tool = makeTavilySearchTool(makeClient({ search: mockSearch }));

    const result = await tool.execute({ query: 'obscure topic' }, mockCtx);
    expect(result.results).toHaveLength(0);
    expect(result.images).toHaveLength(0);
    expect(result.answer).toBeUndefined();
  });

  it('rejects Zod validation for empty query', async () => {
    const tool = makeTavilySearchTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects Zod validation for maxResults above 20', async () => {
    const tool = makeTavilySearchTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ query: 'test', maxResults: 21 });
    expect(parsed.success).toBe(false);
  });
});

// ── tavily_extract ────────────────────────────────────────────────────────────

describe('makeTavilyExtractTool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns tool with correct name and riskLevel', () => {
    const tool = makeTavilyExtractTool(makeClient());
    expect(tool.name).toBe('tavily_extract');
    expect(tool.riskLevel).toBe('read');
  });

  it('passes urls and options to client.extract and maps response', async () => {
    const sdkResponse = {
      results: [
        {
          url: 'https://example.com',
          title: 'Example Domain',
          rawContent: 'This domain is for use in examples.',
        },
      ],
      failedResults: [{ url: 'https://broken.example.com', error: 'Connection timeout' }],
      responseTime: 312,
      requestId: 'req-extract-1',
    };
    const mockExtract = vi.fn().mockResolvedValueOnce(sdkResponse);
    const client = makeClient({ extract: mockExtract });
    const tool = makeTavilyExtractTool(client);

    const result = await tool.execute(
      {
        urls: ['https://example.com', 'https://broken.example.com'],
        extractDepth: 'advanced',
      },
      mockCtx,
    );

    expect(mockExtract).toHaveBeenCalledWith(
      ['https://example.com', 'https://broken.example.com'],
      { extractDepth: 'advanced' },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe('https://example.com');
    expect(result.results[0]?.title).toBe('Example Domain');
    expect(result.results[0]?.rawContent).toContain('examples');
    expect(result.failedResults).toHaveLength(1);
    expect(result.failedResults[0]?.url).toBe('https://broken.example.com');
    expect(result.failedResults[0]?.error).toBe('Connection timeout');
    expect(result.responseTime).toBe(312);
  });

  it('defaults extractDepth to basic when omitted', async () => {
    const mockExtract = vi.fn().mockResolvedValueOnce({
      results: [],
      failedResults: [],
      responseTime: 50,
      requestId: 'req-3',
    });
    const tool = makeTavilyExtractTool(makeClient({ extract: mockExtract }));

    await tool.execute({ urls: ['https://example.com'] }, mockCtx);

    expect(mockExtract).toHaveBeenCalledWith(['https://example.com'], { extractDepth: 'basic' });
  });

  it('wraps SDK errors in TavilyApiError', async () => {
    const mockExtract = vi.fn().mockRejectedValueOnce(new Error('Network error'));
    const tool = makeTavilyExtractTool(makeClient({ extract: mockExtract }));

    await expect(tool.execute({ urls: ['https://example.com'] }, mockCtx)).rejects.toSatisfy(
      (err: unknown) => err instanceof TavilyApiError && err.code === 'tavily_unknown',
    );
  });

  it('rejects Zod validation when urls array is empty', async () => {
    const tool = makeTavilyExtractTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ urls: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects Zod validation when urls array exceeds 20 items', async () => {
    const tool = makeTavilyExtractTool(makeClient());
    const tooMany = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
    const parsed = tool.inputSchema.safeParse({ urls: tooMany });
    expect(parsed.success).toBe(false);
  });

  it('rejects Zod validation for invalid URL in array', async () => {
    const tool = makeTavilyExtractTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ urls: ['not-a-url'] });
    expect(parsed.success).toBe(false);
  });
});

// ── tavily_crawl ──────────────────────────────────────────────────────────────

describe('makeTavilyCrawlTool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns tool with correct name and riskLevel', () => {
    const tool = makeTavilyCrawlTool(makeClient());
    expect(tool.name).toBe('tavily_crawl');
    expect(tool.riskLevel).toBe('read');
  });

  it('passes url and options to client.crawl and maps response', async () => {
    const sdkResponse = {
      baseUrl: 'https://docs.example.com',
      results: [
        { url: 'https://docs.example.com/intro', rawContent: 'Introduction content', images: [] },
        { url: 'https://docs.example.com/guide', rawContent: 'Guide content', images: [] },
      ],
      responseTime: 890,
      requestId: 'req-crawl-1',
    };
    const mockCrawl = vi.fn().mockResolvedValueOnce(sdkResponse);
    const client = makeClient({ crawl: mockCrawl });
    const tool = makeTavilyCrawlTool(client);

    const result = await tool.execute(
      {
        url: 'https://docs.example.com',
        maxDepth: 2,
        limit: 15,
      },
      mockCtx,
    );

    expect(mockCrawl).toHaveBeenCalledWith('https://docs.example.com', {
      maxDepth: 2,
      limit: 15,
    });

    expect(result.baseUrl).toBe('https://docs.example.com');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.url).toBe('https://docs.example.com/intro');
    expect(result.results[0]?.rawContent).toBe('Introduction content');
    expect(result.results[1]?.url).toBe('https://docs.example.com/guide');
    expect(result.responseTime).toBe(890);
  });

  it('defaults maxDepth to 1 and limit to 10 when omitted', async () => {
    const mockCrawl = vi.fn().mockResolvedValueOnce({
      baseUrl: 'https://example.com',
      results: [],
      responseTime: 100,
      requestId: 'req-4',
    });
    const tool = makeTavilyCrawlTool(makeClient({ crawl: mockCrawl }));

    await tool.execute({ url: 'https://example.com' }, mockCtx);

    expect(mockCrawl).toHaveBeenCalledWith('https://example.com', {
      maxDepth: 1,
      limit: 10,
    });
  });

  it('wraps SDK errors in TavilyApiError', async () => {
    const mockCrawl = vi.fn().mockRejectedValueOnce(new Error('Crawl failed'));
    const tool = makeTavilyCrawlTool(makeClient({ crawl: mockCrawl }));

    await expect(tool.execute({ url: 'https://example.com' }, mockCtx)).rejects.toSatisfy(
      (err: unknown) => err instanceof TavilyApiError && err.code === 'tavily_unknown',
    );
  });

  it('rejects Zod validation for maxDepth above 5', async () => {
    const tool = makeTavilyCrawlTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ url: 'https://example.com', maxDepth: 6 });
    expect(parsed.success).toBe(false);
  });

  it('rejects Zod validation for limit above 50', async () => {
    const tool = makeTavilyCrawlTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ url: 'https://example.com', limit: 51 });
    expect(parsed.success).toBe(false);
  });

  it('rejects Zod validation for invalid URL', async () => {
    const tool = makeTavilyCrawlTool(makeClient());
    const parsed = tool.inputSchema.safeParse({ url: 'not-a-url' });
    expect(parsed.success).toBe(false);
  });
});
