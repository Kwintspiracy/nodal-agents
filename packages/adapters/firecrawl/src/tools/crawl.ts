// @nodal-agents/adapter-firecrawl — crawl tools
//
// Design choice: firecrawl_crawl_start + firecrawl_crawl_status (two tools)
// rather than a single blocking firecrawl_crawl.
//
// Rationale: The Firecrawl SDK crawl API is inherently async — startCrawl()
// returns a job ID immediately, and the actual documents are fetched by polling
// getCrawlStatus(). Exposing a single blocking tool would silently hold the
// LLM context open for minutes and risk timeout / token-limit issues on large
// sites. The two-tool split lets the agent start a job, do other work, then
// poll status in a subsequent turn — matching the SDK's natural shape.

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { FirecrawlClient } from '../client.ts';
import { wrapFirecrawlError } from '../errors.ts';
import { capField } from './scrape.ts';

// audit#2026-07-07 F9: capField bounds each document's markdown/html, but
// nothing bounded the NUMBER of documents returned in one status poll — a
// crawl with hundreds of completed pages would still return them all,
// each up to 15000 chars, in a single tool result. Cap the page count too,
// same truncated-flag pattern as the per-doc cap.
const MAX_CRAWL_DOCS_PER_CALL = 50;

// ── firecrawl_crawl_start ─────────────────────────────────────────────────────

const CrawlStartInput = z.object({
  url: z.string().url().describe('The root URL to crawl.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of pages to crawl (1–100).'),
});

export type CrawlStartOutput = {
  id: string;
  url: string;
};

export function makeFirecrawlCrawlStartTool(
  client: FirecrawlClient,
): ToolDefinition<typeof CrawlStartInput, CrawlStartOutput> {
  return {
    name: 'firecrawl_crawl_start',
    description:
      'Start an async crawl job for a website. Returns a job ID. Use firecrawl_crawl_status to poll for results.',
    inputSchema: CrawlStartInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const response = await client.startCrawl(input.url, {
          ...(input.limit !== undefined && { limit: input.limit }),
        });
        return {
          id: response.id,
          url: response.url,
        };
      } catch (err) {
        throw wrapFirecrawlError(err);
      }
    },
  };
}

// ── firecrawl_crawl_status ────────────────────────────────────────────────────

const CrawlStatusInput = z.object({
  id: z.string().min(1).describe('The crawl job ID returned by firecrawl_crawl_start.'),
});

export type CrawlDocument = {
  url?: string;
  markdown?: string;
  html?: string;
  truncated: boolean;
};

export type CrawlStatusOutput = {
  id: string;
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  data: CrawlDocument[];
  /** true if more documents were available than MAX_CRAWL_DOCS_PER_CALL (audit#2026-07-07 F9). */
  dataTruncated: boolean;
};

export function makeFirecrawlCrawlStatusTool(
  client: FirecrawlClient,
): ToolDefinition<typeof CrawlStatusInput, CrawlStatusOutput> {
  return {
    name: 'firecrawl_crawl_status',
    description:
      'Get the current status and partial results of a Firecrawl crawl job. Poll this until status is "completed", "failed", or "cancelled". ' +
      `Capped at ${MAX_CRAWL_DOCS_PER_CALL} documents per call — see the dataTruncated flag.`,
    inputSchema: CrawlStatusInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const job = await client.getCrawlStatus(input.id);
        const rawData = job.data ?? [];
        const dataTruncated = rawData.length > MAX_CRAWL_DOCS_PER_CALL;
        return {
          id: job.id,
          status: job.status,
          total: job.total,
          completed: job.completed,
          data: rawData.slice(0, MAX_CRAWL_DOCS_PER_CALL).map((doc) => {
            const md = capField(doc.markdown);
            const html = capField(doc.html);
            return {
              ...(doc.metadata?.url !== undefined && { url: doc.metadata.url as string }),
              ...(md.content !== undefined && { markdown: md.content }),
              ...(html.content !== undefined && { html: html.content }),
              truncated: md.truncated || html.truncated,
            };
          }),
          dataTruncated,
        };
      } catch (err) {
        throw wrapFirecrawlError(err);
      }
    },
  };
}
