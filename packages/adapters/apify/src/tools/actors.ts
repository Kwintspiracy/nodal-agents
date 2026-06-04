// @nodal-agents/adapter-apify — actor run tools

import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import type { ApifyClient } from '../client.ts';
import { wrapApifyError } from '../errors.ts';

// ── apify_web_browse ──────────────────────────────────────────────────────────
// SYNCHRONOUS web scrape/search. Runs Apify's rag-web-browser actor AND fetches
// its dataset inline, so the agent gets the page content back in ONE tool call —
// no run handle, no poll loop. This is the key difference from the hosted Apify
// MCP server's actor tool, which returns an async run the agent has to poll
// itself (3+ calls/scrape, and weak models re-fire the search instead of
// polling). Long-running actors should NOT use this shape — they belong on the
// runner's submit→suspend→resume path. rag-web-browser is short (seconds), so a
// blocking call is the correct trade-off.

const WebBrowseInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'A web page URL to scrape, OR free-text search terms. A URL returns that page; search terms return the top results.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('For a search query, how many results to return (default 3). Ignored for a single URL.'),
});

export type WebBrowseResult = { url: string; title: string; content: string };
export type WebBrowseOutput = { query: string; count: number; results: WebBrowseResult[] };

/**
 * Strip control characters (except tab / newline / carriage-return) that creep
 * into scraped pages. They are noise, and they can corrupt the request/response
 * round-trip to the LLM provider (a malformed body surfaces as the SDK's
 * "Invalid JSON response"). Keeps the content clean and transport-safe.
 */
function sanitizeScraped(s: string): string {
  // Keep tab (9), newline (10), carriage-return (13); drop other C0/C1 control
  // chars and DEL (127). Surrogate-pair characters (emoji) survive: charCodeAt(0)
  // of a high surrogate is >= 0xD800, well above 32.
  return Array.from(s)
    .filter((ch) => {
      const x = ch.charCodeAt(0);
      return x === 9 || x === 10 || x === 13 || (x >= 32 && x !== 127);
    })
    .join('');
}

/** Pull a usable {url,title,content} out of a rag-web-browser dataset item, whatever shape it came in. */
function normalizeBrowseItem(raw: unknown): WebBrowseResult {
  const item = (raw ?? {}) as Record<string, unknown>;
  const meta = (item['metadata'] ?? {}) as Record<string, unknown>;
  const search = (item['searchResult'] ?? {}) as Record<string, unknown>;
  const crawl = (item['crawl'] ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  // We request `text` output (the proven, lighter format the legacy skill used —
  // markdown is heavier and special-char-dense), so `text` is preferred; markdown
  // is only a fallback if a route omitted text.
  return {
    url: str(meta['url']) || str(search['url']) || str(crawl['loadedUrl']) || str(item['url']),
    title: sanitizeScraped(str(meta['title']) || str(search['title']) || str(item['title'])),
    content: sanitizeScraped(str(item['text']) || str(item['markdown']) || ''),
  };
}

/**
 * Runs apify/rag-web-browser via the official SDK's blocking `.call()` (which
 * polls the run to completion internally), then reads the dataset inline. The
 * agent sees a single synchronous call returning the scraped content.
 */
export function makeApifyWebBrowseTool(
  client: ApifyClient,
): ToolDefinition<typeof WebBrowseInput, WebBrowseOutput> {
  return {
    name: 'apify_web_browse',
    description:
      'Scrape a web page or run a web search and get the content back in ONE call (synchronous — no polling). Pass a URL to scrape that page, or search terms to get the top results. Use this as the DEFAULT web tool. Consumes a small amount of Apify credits per call.',
    inputSchema: WebBrowseInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const run = await client.actor('apify/rag-web-browser').call({
          query: input.query,
          // `text` is the proven, lighter output the legacy skill used. Markdown is
          // heavier and special-char-dense — an unnecessary deviation that changed
          // the request/response load profile. Stay on the format that always worked.
          outputFormats: ['text'],
          maxResults: input.maxResults ?? 3,
        });
        const dataset = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
        const results = (dataset.items ?? []).map(normalizeBrowseItem).filter((r) => r.content);
        return { query: input.query, count: results.length, results };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}

// ── apify_run_actor ───────────────────────────────────────────────────────────

const RunActorInput = z.object({
  actorId: z
    .string()
    .describe(
      'The actor ID or name in the format "owner/actor-name" (e.g. "apify/web-scraper") or just the actor ID.',
    ),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Input object to pass to the actor. Structure depends on the actor. Omit to use actor defaults.',
    ),
});

export type RunActorOutput = {
  runId: string;
  datasetId: string;
  status: string;
};

/**
 * Calls client.actor(actorId).call(input) which blocks until the run finishes.
 * The SDK handles polling internally — this tool will not return until the actor
 * run reaches a terminal state (SUCCEEDED, FAILED, ABORTED, etc.).
 */
export function makeApifyRunActorTool(
  client: ApifyClient,
): ToolDefinition<typeof RunActorInput, RunActorOutput> {
  return {
    name: 'apify_run_actor',
    description:
      'Start an Apify actor run and wait for it to finish (blocking). Returns the run ID, output dataset ID, and final status. This tool consumes Apify platform credits — use apify_get_dataset_items to retrieve results after the run succeeds.',
    inputSchema: RunActorInput,
    riskLevel: 'write',
    async execute(input) {
      try {
        const run = await client.actor(input.actorId).call(input.input);
        return {
          runId: run.id,
          datasetId: run.defaultDatasetId,
          status: run.status,
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}

// ── apify_get_run ─────────────────────────────────────────────────────────────

const GetRunInput = z.object({
  runId: z.string().describe('The Apify run ID to retrieve metadata for.'),
});

export type GetRunOutput = {
  id: string;
  actId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
};

export function makeApifyGetRunTool(
  client: ApifyClient,
): ToolDefinition<typeof GetRunInput, GetRunOutput> {
  return {
    name: 'apify_get_run',
    description:
      'Retrieve metadata for an Apify actor run by its run ID. Returns status, actor ID, dataset ID, and timestamps.',
    inputSchema: GetRunInput,
    riskLevel: 'read',
    async execute(input) {
      try {
        const run = await client.run(input.runId).get();
        if (!run) {
          const { ApifyApiError } = await import('../errors.ts');
          throw new ApifyApiError('apify_not_found', `Run ${input.runId} not found`, 404);
        }
        return {
          id: run.id,
          actId: run.actId,
          status: run.status,
          startedAt: run.startedAt ? run.startedAt.toISOString() : null,
          finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
          defaultDatasetId: run.defaultDatasetId,
          defaultKeyValueStoreId: run.defaultKeyValueStoreId,
        };
      } catch (err) {
        throw wrapApifyError(err);
      }
    },
  };
}
