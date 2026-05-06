// Built-in: web_search
// Placeholder — throws unless NODALAI_WEB_SEARCH_URL env var is configured.
// Real implementation deferred to a future brick.

import { z } from 'zod';
import type { ToolDefinition } from '../types';
import { WebSearchNotConfiguredError } from '../errors';

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
}

export const webSearchTool: ToolDefinition<typeof WebSearchInputSchema, WebSearchResult> = {
  name: 'web_search',
  description:
    'Search the web for current information. Use when you need up-to-date data, ' +
    'news, or any facts you are not sure about.',
  inputSchema: WebSearchInputSchema,
  riskLevel: 'read',
  execute: async (_input, _ctx) => {
    // Check if a search backend is configured
    const searchUrl = process.env['NODALAI_WEB_SEARCH_URL'];
    if (!searchUrl) {
      throw new WebSearchNotConfiguredError();
    }

    // Real implementation will call the configured search API here.
    // This branch is unreachable in tests (env var not set).
    throw new WebSearchNotConfiguredError();
  },
};
