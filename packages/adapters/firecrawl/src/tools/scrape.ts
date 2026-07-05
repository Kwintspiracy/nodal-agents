// @nodal-agents/adapter-firecrawl — scrape, map, and search tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { FirecrawlClient } from '../client.ts';
import { wrapFirecrawlError } from '../errors.ts';

// audit#2 F-17: unlike gmail/drive/notion, markdown/html were returned
// unbounded — a large scraped page could burn the agent's whole token budget
// on a single tool result. Same cap + truncated flag pattern used by
// packages/adapters/google-drive/src/tools/read-file.ts.
//
// html is capped too (not just markdown): it's a selectable format
// (formats:['html']) and is typically LARGER than markdown for the same
// page, so leaving it uncapped would just move the budget-burn vector
// sideways instead of closing it.
const CHAR_CAP = 15000;

/** Cap a text field at CHAR_CAP chars, if present. Shared across scrape.ts/crawl.ts for markdown AND html. */
export function capField(text: string | undefined): { content?: string; truncated: boolean } {
  if (text === undefined) return { truncated: false };
  const truncated = text.length > CHAR_CAP;
  return {
    content: truncated
      ? text.slice(0, CHAR_CAP) + `\n\n[...content truncated at ${CHAR_CAP} chars...]`
      : text,
    truncated,
  };
}

// ── firecrawl_scrape ──────────────────────────────────────────────────────────

const ScrapeInput = z.object({
  url: z.string().url().describe('The URL to scrape.'),
  formats: z
    .array(z.enum(['markdown', 'html', 'links']))
    .optional()
    .default(['markdown'])
    .describe("Content formats to return. Defaults to ['markdown']."),
});

export type ScrapeOutput = {
  url: string;
  markdown?: string;
  html?: string;
  links?: string[];
  truncated: boolean;
};

export function makeFirecrawlScrapeTool(
  client: FirecrawlClient,
): ToolDefinition<typeof ScrapeInput, ScrapeOutput> {
  return {
    name: 'firecrawl_scrape',
    description:
      'Scrape a single web page and return its content. Supports markdown (default), raw HTML, and extracted links.',
    inputSchema: ScrapeInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const doc = await client.scrape(input.url, {
          formats: input.formats as ('markdown' | 'html' | 'links')[],
        });
        const md = capField(doc.markdown);
        const html = capField(doc.html);
        return {
          url: input.url,
          ...(md.content !== undefined && { markdown: md.content }),
          ...(html.content !== undefined && { html: html.content }),
          ...(doc.links !== undefined && { links: doc.links as string[] }),
          truncated: md.truncated || html.truncated,
        };
      } catch (err) {
        throw wrapFirecrawlError(err);
      }
    },
  };
}

// ── firecrawl_map ─────────────────────────────────────────────────────────────

const MapInput = z.object({
  url: z.string().url().describe('The root URL whose site to map.'),
  search: z
    .string()
    .optional()
    .describe('Optional keyword filter — only return URLs matching this term.'),
});

export type MapOutput = {
  links: Array<{ url: string; title?: string; description?: string }>;
};

export function makeFirecrawlMapTool(
  client: FirecrawlClient,
): ToolDefinition<typeof MapInput, MapOutput> {
  return {
    name: 'firecrawl_map',
    description:
      'Discover all URLs on a website (sitemap-aware). Returns a list of links with optional titles and descriptions. Use the search param to filter results.',
    inputSchema: MapInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const result = await client.map(input.url, {
          ...(input.search !== undefined && { search: input.search }),
        });
        return {
          links: (result.links ?? []).map((l) => ({
            url: l.url,
            ...(l.title !== undefined && { title: l.title }),
            ...(l.description !== undefined && { description: l.description }),
          })),
        };
      } catch (err) {
        throw wrapFirecrawlError(err);
      }
    },
  };
}

// ── firecrawl_search ──────────────────────────────────────────────────────────

const SearchInput = z.object({
  query: z.string().min(1).describe('The search query to send to Firecrawl.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of results to return (1–100).'),
});

export type SearchResultItem = {
  url: string;
  title?: string;
  description?: string;
};

export type SearchOutput = {
  results: SearchResultItem[];
};

export function makeFirecrawlSearchTool(
  client: FirecrawlClient,
): ToolDefinition<typeof SearchInput, SearchOutput> {
  return {
    name: 'firecrawl_search',
    description:
      'Search the web via Firecrawl and return a list of web results (URL, title, description).',
    inputSchema: SearchInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const data = await client.search(input.query, {
          ...(input.limit !== undefined && { limit: input.limit }),
        });
        const webItems = data.web ?? [];
        const results: SearchResultItem[] = webItems.map((item) => {
          // SDK returns SearchResultWeb | Document — both have a url field
          const r = item as { url?: string; title?: string; description?: string };
          return {
            url: r.url ?? '',
            ...(r.title !== undefined && { title: r.title }),
            ...(r.description !== undefined && { description: r.description }),
          };
        });
        return { results };
      } catch (err) {
        throw wrapFirecrawlError(err);
      }
    },
  };
}
