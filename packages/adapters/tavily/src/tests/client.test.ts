// @nodalai/adapter-tavily — client factory tests

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTavilyClient } from '../client.ts';
import { TavilyApiError } from '../errors.ts';

const FAKE_TOKEN = 'tvly-fake-access-token-123';

// Mock the @tavily/core SDK
const mockSearch = vi.fn();
const mockExtract = vi.fn();
const mockCrawl = vi.fn();

vi.mock('@tavily/core', () => ({
  tavily: vi.fn((opts: { apiKey?: string }) => {
    // Capture the apiKey passed to the factory so we can assert on it
    return {
      _apiKey: opts.apiKey,
      search: mockSearch,
      extract: mockExtract,
      crawl: mockCrawl,
    };
  }),
}));

describe('createTavilyClient — instantiation', () => {
  it('creates a client without throwing', () => {
    expect(() => createTavilyClient(FAKE_TOKEN)).not.toThrow();
  });

  it('creates distinct client instances per call', () => {
    const a = createTavilyClient('token-a');
    const b = createTavilyClient('token-b');
    expect(a).not.toBe(b);
  });
});

describe('createTavilyClient — SDK delegation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates search() to the SDK with the provided arguments', async () => {
    const expectedResponse = {
      query: 'TypeScript tips',
      results: [
        {
          title: 'TS Guide',
          url: 'https://example.com',
          content: 'Content',
          score: 0.9,
          publishedDate: '2024-01-01',
        },
      ],
      images: [],
      responseTime: 123,
      requestId: 'req-1',
    };
    mockSearch.mockResolvedValueOnce(expectedResponse);

    const client = createTavilyClient(FAKE_TOKEN);
    const result = await client.search('TypeScript tips', { maxResults: 3 });

    expect(mockSearch).toHaveBeenCalledWith('TypeScript tips', { maxResults: 3 });
    expect(result).toBe(expectedResponse);
  });

  it('delegates extract() to the SDK with the provided arguments', async () => {
    const expectedResponse = {
      results: [{ url: 'https://example.com', title: 'Example', rawContent: 'Page content' }],
      failedResults: [],
      responseTime: 200,
      requestId: 'req-2',
    };
    mockExtract.mockResolvedValueOnce(expectedResponse);

    const client = createTavilyClient(FAKE_TOKEN);
    const result = await client.extract(['https://example.com'], { extractDepth: 'basic' });

    expect(mockExtract).toHaveBeenCalledWith(['https://example.com'], { extractDepth: 'basic' });
    expect(result).toBe(expectedResponse);
  });

  it('delegates crawl() to the SDK with the provided arguments', async () => {
    const expectedResponse = {
      baseUrl: 'https://example.com',
      results: [{ url: 'https://example.com/page', rawContent: 'Page body', images: [] }],
      responseTime: 350,
      requestId: 'req-3',
    };
    mockCrawl.mockResolvedValueOnce(expectedResponse);

    const client = createTavilyClient(FAKE_TOKEN);
    const result = await client.crawl('https://example.com', { maxDepth: 2, limit: 5 });

    expect(mockCrawl).toHaveBeenCalledWith('https://example.com', { maxDepth: 2, limit: 5 });
    expect(result).toBe(expectedResponse);
  });
});

describe('createTavilyClient — error propagation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('propagates SDK errors as-is (tools wrap them via wrapTavilyError)', async () => {
    const sdkError = new Error('Network failure');
    mockSearch.mockRejectedValueOnce(sdkError);

    const client = createTavilyClient(FAKE_TOKEN);
    await expect(client.search('test')).rejects.toThrow('Network failure');
  });

  it('does not swallow TavilyApiError thrown by SDK', async () => {
    const apiError = new TavilyApiError('tavily_rate_limited', 'Rate limit exceeded', 429);
    mockSearch.mockRejectedValueOnce(apiError);

    const client = createTavilyClient(FAKE_TOKEN);
    await expect(client.search('test')).rejects.toSatisfy(
      (err: unknown) => err instanceof TavilyApiError && err.code === 'tavily_rate_limited',
    );
  });
});
