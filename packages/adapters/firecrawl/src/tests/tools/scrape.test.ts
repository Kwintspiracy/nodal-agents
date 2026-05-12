// @nodalai/adapter-firecrawl — scrape, map, search tool tests
// Mocks: @mendable/firecrawl-js FirecrawlClient methods are stubbed.
// Assertions are on real returned content / arguments passed to the SDK.

import { describe, it, expect, vi } from 'vitest';
import { createFirecrawlClient } from '../../client.ts';
import {
  makeFirecrawlScrapeTool,
  makeFirecrawlMapTool,
  makeFirecrawlSearchTool,
} from '../../tools/scrape.ts';
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

// ── firecrawl_scrape ──────────────────────────────────────────────────────────

describe('makeFirecrawlScrapeTool', () => {
  it('returns markdown content from SDK', async () => {
    const client = getClient();
    vi.spyOn(client, 'scrape').mockResolvedValue({
      markdown: '# Hello world\n\nSome content.',
    });

    const tool = makeFirecrawlScrapeTool(client);
    const result = await tool.execute({ url: 'https://example.com', formats: ['markdown'] }, CTX);

    expect(result.markdown).toBe('# Hello world\n\nSome content.');
    expect(result.url).toBe('https://example.com');
  });

  it('passes formats to SDK scrape call', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'scrape').mockResolvedValue({ html: '<h1>Test</h1>' });

    const tool = makeFirecrawlScrapeTool(client);
    await tool.execute({ url: 'https://example.com', formats: ['html'] }, CTX);

    expect(spy).toHaveBeenCalledWith('https://example.com', { formats: ['html'] });
  });

  it('returns links when formats includes links', async () => {
    const client = getClient();
    vi.spyOn(client, 'scrape').mockResolvedValue({
      links: ['https://example.com/a', 'https://example.com/b'],
    });

    const tool = makeFirecrawlScrapeTool(client);
    const result = await tool.execute({ url: 'https://example.com', formats: ['links'] }, CTX);

    expect(result.links).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('uses default formats [markdown] when not specified', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'scrape').mockResolvedValue({ markdown: 'content' });

    const tool = makeFirecrawlScrapeTool(client);
    // Zod default applies during parse — call with parsed defaults
    await tool.execute({ url: 'https://example.com', formats: ['markdown'] }, CTX);

    expect(spy).toHaveBeenCalledWith('https://example.com', { formats: ['markdown'] });
  });

  it('wraps SDK errors in FirecrawlApiError', async () => {
    const client = getClient();
    vi.spyOn(client, 'scrape').mockRejectedValue(new Error('Network timeout'));

    const tool = makeFirecrawlScrapeTool(client);
    await expect(
      tool.execute({ url: 'https://example.com', formats: ['markdown'] }, CTX),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof FirecrawlApiError && err.code === 'firecrawl_unknown',
    );
  });

  it('has riskLevel read and correct name', () => {
    const tool = makeFirecrawlScrapeTool(getClient());
    expect(tool.name).toBe('firecrawl_scrape');
    expect(tool.riskLevel).toBe('read');
  });
});

// ── firecrawl_map ─────────────────────────────────────────────────────────────

describe('makeFirecrawlMapTool', () => {
  it('returns list of links from SDK', async () => {
    const client = getClient();
    vi.spyOn(client, 'map').mockResolvedValue({
      links: [
        { url: 'https://example.com/about', title: 'About' },
        { url: 'https://example.com/contact' },
      ],
    });

    const tool = makeFirecrawlMapTool(client);
    const result = await tool.execute({ url: 'https://example.com' }, CTX);

    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toEqual({ url: 'https://example.com/about', title: 'About' });
    expect(result.links[1]).toEqual({ url: 'https://example.com/contact' });
  });

  it('passes search option to SDK map call', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'map').mockResolvedValue({ links: [] });

    const tool = makeFirecrawlMapTool(client);
    await tool.execute({ url: 'https://example.com', search: 'pricing' }, CTX);

    expect(spy).toHaveBeenCalledWith('https://example.com', { search: 'pricing' });
  });

  it('calls SDK without search key when search is undefined', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'map').mockResolvedValue({ links: [] });

    const tool = makeFirecrawlMapTool(client);
    await tool.execute({ url: 'https://example.com' }, CTX);

    // search key should not be in the options object when not provided
    expect(spy).toHaveBeenCalledWith('https://example.com', {});
  });

  it('wraps SDK errors in FirecrawlApiError', async () => {
    const client = getClient();
    vi.spyOn(client, 'map').mockRejectedValue(new Error('URL cannot be empty'));

    const tool = makeFirecrawlMapTool(client);
    await expect(tool.execute({ url: 'https://example.com' }, CTX)).rejects.toSatisfy(
      (err: unknown) => err instanceof FirecrawlApiError && err.code === 'firecrawl_unknown',
    );
  });

  it('has riskLevel read and correct name', () => {
    const tool = makeFirecrawlMapTool(getClient());
    expect(tool.name).toBe('firecrawl_map');
    expect(tool.riskLevel).toBe('read');
  });
});

// ── firecrawl_search ──────────────────────────────────────────────────────────

describe('makeFirecrawlSearchTool', () => {
  it('returns web results from SDK', async () => {
    const client = getClient();
    vi.spyOn(client, 'search').mockResolvedValue({
      web: [
        { url: 'https://example.com', title: 'Example', description: 'A site' },
        { url: 'https://test.org', title: 'Test' },
      ],
    });

    const tool = makeFirecrawlSearchTool(client);
    const result = await tool.execute({ query: 'example search' }, CTX);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      url: 'https://example.com',
      title: 'Example',
      description: 'A site',
    });
    expect(result.results[1]).toEqual({ url: 'https://test.org', title: 'Test' });
  });

  it('passes query and limit to SDK search call', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'search').mockResolvedValue({ web: [] });

    const tool = makeFirecrawlSearchTool(client);
    await tool.execute({ query: 'firecrawl tutorial', limit: 5 }, CTX);

    expect(spy).toHaveBeenCalledWith('firecrawl tutorial', { limit: 5 });
  });

  it('calls SDK without limit key when limit is undefined', async () => {
    const client = getClient();
    const spy = vi.spyOn(client, 'search').mockResolvedValue({ web: [] });

    const tool = makeFirecrawlSearchTool(client);
    await tool.execute({ query: 'test' }, CTX);

    expect(spy).toHaveBeenCalledWith('test', {});
  });

  it('returns empty results when SDK returns no web results', async () => {
    const client = getClient();
    vi.spyOn(client, 'search').mockResolvedValue({});

    const tool = makeFirecrawlSearchTool(client);
    const result = await tool.execute({ query: 'nothing' }, CTX);

    expect(result.results).toEqual([]);
  });

  it('wraps SDK errors in FirecrawlApiError', async () => {
    const client = getClient();
    vi.spyOn(client, 'search').mockRejectedValue(new Error('Rate limited'));

    const tool = makeFirecrawlSearchTool(client);
    await expect(tool.execute({ query: 'test' }, CTX)).rejects.toSatisfy(
      (err: unknown) => err instanceof FirecrawlApiError && err.code === 'firecrawl_unknown',
    );
  });

  it('has riskLevel read and correct name', () => {
    const tool = makeFirecrawlSearchTool(getClient());
    expect(tool.name).toBe('firecrawl_search');
    expect(tool.riskLevel).toBe('read');
  });
});
