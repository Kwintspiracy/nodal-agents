// Built-in: web_search
// Unified, always-on web search. Backend priority:
//   1. ctx.searchBackend  — a premium provider (Tavily > Firecrawl) INJECTED by
//      the runner when the agent has that connector. packages/tools must NOT
//      depend on adapters/secrets, so the premium client is passed in, never
//      built here.
//   2. DuckDuckGo (keyless) — a free best-effort fallback that lives IN this
//      builtin (pure fetch + HTML parse, no dependency). It can be rate-limited
//      or blocked; when it fails or returns nothing we degrade GRACEFULLY with
//      guidance instead of throwing blindly, so the agent can tell the user how
//      to get reliable results (add a Tavily key).

import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).describe('The search query.'),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export interface WebSearchResult {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  /**
   * True when the free DuckDuckGo fallback failed or returned zero results
   * (rate-limited / blocked / markup changed). The `results` array is empty in
   * that case and `guidance` explains the next step. Absent when results came
   * back normally (premium backend or a successful DuckDuckGo scrape).
   */
  degraded?: boolean;
  /**
   * User-facing next-step guidance surfaced only when `degraded` is true, so the
   * agent can relay a concrete remedy rather than a bare empty result.
   */
  guidance?: string;
}

const DEGRADED_GUIDANCE =
  'Free best-effort web search failed (it can be rate-limited or blocked). For reliable ' +
  "results, add a Tavily key (free tier) in the dashboard under Connectors, and I'll use it " +
  'automatically.';

// DuckDuckGo's keyless HTML endpoint. Returns a server-rendered results page:
// each result is an `<a class="result__a" href="…">title</a>` plus an adjacent
// `<a class="result__snippet">snippet</a>`. The href is a DDG redirect
// (`//duckduckgo.com/l/?uddg=<url-encoded target>&…`) which we unwrap.
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

/** Strip HTML tags and decode the handful of entities DDG emits in titles/snippets. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Unwrap a DDG redirect href (`…/l/?uddg=<encoded>`) to the real target URL. */
function resolveDdgHref(href: string): string {
  const normalized = href.startsWith('//') ? `https:${href}` : href;
  const uddg = normalized.match(/[?&]uddg=([^&]+)/);
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      // malformed encoding — fall through to the raw href
    }
  }
  return normalized;
}

/**
 * Parse a DuckDuckGo HTML results page into {title, url, snippet} rows.
 * Defensive by design: iterates over each `result__a` anchor and looks for the
 * NEXT `result__snippet` after it (snippets are optional). Regex-only — no HTML
 * parser dependency. Returns [] if the markup doesn't match (caller degrades).
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult['results'] {
  const results: WebSearchResult['results'] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const rawTitle = match[2];
    if (!href || rawTitle === undefined) continue;
    const title = stripHtml(rawTitle);
    const url = resolveDdgHref(href);
    if (!title || !url) continue;

    // Find the first snippet anchor that appears AFTER this result's title.
    snippetRe.lastIndex = anchorRe.lastIndex;
    const snippetMatch = snippetRe.exec(html);
    const snippet = snippetMatch?.[1] ? stripHtml(snippetMatch[1]) : '';

    results.push({ title, url, snippet });
  }
  return results;
}

async function duckDuckGoSearch(query: string): Promise<WebSearchResult> {
  let html: string;
  try {
    const res = await fetch(DDG_ENDPOINT, {
      // The html endpoint blocks GET (returns 202 with an empty challenge page)
      // but serves 200 + real results for a form POST. A browser-ish UA is also
      // required (bare requests are refused).
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'q=' + encodeURIComponent(query),
    });
    if (!res.ok) {
      return { results: [], degraded: true, guidance: DEGRADED_GUIDANCE };
    }
    html = await res.text();
  } catch {
    // Network error / DNS / timeout — degrade, don't throw.
    return { results: [], degraded: true, guidance: DEGRADED_GUIDANCE };
  }

  const results = parseDuckDuckGoHtml(html);
  if (results.length === 0) {
    return { results: [], degraded: true, guidance: DEGRADED_GUIDANCE };
  }
  return { results };
}

export const webSearchTool: ToolDefinition<typeof WebSearchInputSchema, WebSearchResult> = {
  name: 'web_search',
  description:
    'Search the web. Uses your configured Tavily/Firecrawl provider if any, otherwise a free ' +
    'best-effort search.',
  inputSchema: WebSearchInputSchema,
  riskLevel: 'read',
  card: 'search',
  execute: async (input, ctx) => {
    // Premium backend injected by the runner (Tavily > Firecrawl) wins.
    if (ctx.searchBackend) {
      const { results } = await ctx.searchBackend(input.query);
      return { results };
    }
    // Free keyless fallback.
    return duckDuckGoSearch(input.query);
  },
};
