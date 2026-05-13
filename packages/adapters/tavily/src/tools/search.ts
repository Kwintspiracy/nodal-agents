// @nodal-agents/adapter-tavily — search, extract, and crawl tools

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '@nodal-agents/tools';
import type { TavilyClient } from '../client.ts';
import { wrapTavilyError } from '../errors.ts';

// ── tavily_search ─────────────────────────────────────────────────────────────

const SearchInput = z.object({
  query: z.string().min(1).describe('The search query to send to Tavily.'),
  searchDepth: z
    .enum(['basic', 'advanced'])
    .optional()
    .describe('Search depth: "basic" is faster, "advanced" is more thorough. Default: "basic".'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum number of results to return (1–20, default 5).'),
  includeImages: z
    .boolean()
    .optional()
    .describe('Whether to include image results. Default: false.'),
  topic: z
    .enum(['general', 'news'])
    .optional()
    .describe('Search topic category: "general" or "news". Default: "general".'),
});

export type SearchOutput = {
  query: string;
  answer?: string;
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    publishedDate: string;
  }>;
  images: Array<{ url: string; description?: string }>;
  responseTime: number;
};

export function makeTavilySearchTool(
  client: TavilyClient,
): ToolDefinition<typeof SearchInput, SearchOutput> {
  return {
    name: 'tavily_search',
    description:
      'Search the web using Tavily. Returns ranked results with titles, URLs, content snippets, and relevance scores. Use topic="news" for current events.',
    inputSchema: SearchInput,
    riskLevel: 'read',
    async execute(input, _ctx: ToolContext) {
      try {
        const response = await client.search(input.query, {
          searchDepth: input.searchDepth ?? 'basic',
          maxResults: input.maxResults ?? 5,
          includeImages: input.includeImages ?? false,
          topic: input.topic ?? 'general',
        });
        return {
          query: response.query,
          answer: response.answer,
          results: (response.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
            publishedDate: r.publishedDate,
          })),
          images: (response.images ?? []).map((img) => ({
            url: img.url,
            description: img.description,
          })),
          responseTime: response.responseTime,
        };
      } catch (err) {
        throw wrapTavilyError(err);
      }
    },
  };
}

// ── tavily_extract ────────────────────────────────────────────────────────────

const ExtractInput = z.object({
  urls: z
    .array(z.string().url())
    .min(1)
    .max(20)
    .describe('Array of URLs to extract content from (max 20).'),
  extractDepth: z
    .enum(['basic', 'advanced'])
    .optional()
    .describe('Extraction depth: "basic" or "advanced". Default: "basic".'),
});

export type ExtractOutput = {
  results: Array<{
    url: string;
    title: string | null;
    rawContent: string;
  }>;
  failedResults: Array<{
    url: string;
    error: string;
  }>;
  responseTime: number;
};

export function makeTavilyExtractTool(
  client: TavilyClient,
): ToolDefinition<typeof ExtractInput, ExtractOutput> {
  return {
    name: 'tavily_extract',
    description:
      'Extract the full text content from one or more URLs (max 20). Returns the raw content of each page and a list of URLs that failed to extract.',
    inputSchema: ExtractInput,
    riskLevel: 'read',
    async execute(input, _ctx: ToolContext) {
      try {
        const response = await client.extract(input.urls, {
          extractDepth: input.extractDepth ?? 'basic',
        });
        return {
          results: (response.results ?? []).map((r) => ({
            url: r.url,
            title: r.title,
            rawContent: r.rawContent,
          })),
          failedResults: (response.failedResults ?? []).map((f) => ({
            url: f.url,
            error: f.error,
          })),
          responseTime: response.responseTime,
        };
      } catch (err) {
        throw wrapTavilyError(err);
      }
    },
  };
}

// ── tavily_crawl ──────────────────────────────────────────────────────────────

const CrawlInput = z.object({
  url: z.string().url().describe('The seed URL to start crawling from.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('Maximum link depth to follow from the seed URL (1–5, default 1).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of pages to scrape (1–50, default 10).'),
});

export type CrawlOutput = {
  baseUrl: string;
  results: Array<{
    url: string;
    rawContent: string;
  }>;
  responseTime: number;
};

export function makeTavilyCrawlTool(
  client: TavilyClient,
): ToolDefinition<typeof CrawlInput, CrawlOutput> {
  return {
    name: 'tavily_crawl',
    description:
      'Crawl from a seed URL and return scraped content for all reachable pages up to a depth and page limit. Useful for comprehensive site content extraction.',
    inputSchema: CrawlInput,
    riskLevel: 'read',
    async execute(input, _ctx: ToolContext) {
      try {
        const response = await client.crawl(input.url, {
          maxDepth: input.maxDepth ?? 1,
          limit: input.limit ?? 10,
        });
        return {
          baseUrl: response.baseUrl,
          results: (response.results ?? []).map((r) => ({
            url: r.url,
            rawContent: r.rawContent,
          })),
          responseTime: response.responseTime,
        };
      } catch (err) {
        throw wrapTavilyError(err);
      }
    },
  };
}
