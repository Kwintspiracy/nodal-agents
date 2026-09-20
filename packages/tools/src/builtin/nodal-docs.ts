// Built-in: nodal_docs
//
// The support desk's manual. An agent running inside Nodal-Agents can look up
// what the platform does and WHERE in the dashboard it is done, instead of
// concluding from its own prompt that a feature does not exist.
//
// The incident this answers (2026-09-21, fresh install): asked whether Telegram
// could be configured, the root agent said Telegram was not supported and
// offered to build an MCP server. Telegram is a channel, the prompt only ever
// named connectors and skills, and the documentation that has the answer was
// not shipped and not readable by anything.
//
// The index is DERIVED from apps/docs/content/docs at build time
// (apps/docs/scripts/gen-docs-index.ts). This tool never carries a copy of a
// product fact: a wrong answer is a documentation bug, fixed in the one place
// the documentation lives.

import { z } from 'zod';
import type { ToolDefinition } from '../types';
import { searchCard, clip } from '../presenters';
import { loadDocsIndex, searchDocs } from './docs-index';

export const NodalDocsInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "What you want to know about the Nodal-Agents platform, in the user's own words — " +
        '"how do I set up a Telegram bot", "what is a cron automation", "where do I approve ' +
        'a tool call". Keywords work as well as a sentence.',
    ),
});

export type NodalDocsInput = z.infer<typeof NodalDocsInputSchema>;

export interface NodalDocsSection {
  /** Heading of the passage, e.g. "Set up the bot". */
  title: string;
  /** Page it comes from, e.g. "Telegram". */
  page: string;
  /** Where the user can read it, e.g. "/nodal-agents/docs/guides/telegram#set-up-the-bot". */
  url: string;
  /** The passage itself, plain text. */
  text: string;
}

/**
 * How many passages come back, and how much of each.
 *
 * Three is the point where a second topic gets a chance without the result
 * turning into a page dump: this runs inside an LLM turn, and the whole answer
 * has to stay small enough that consulting the manual is never the expensive
 * option. 1200 characters is a long section's first two paragraphs — enough to
 * carry the steps, short enough that three of them cost about a thousand
 * tokens.
 */
export const NODAL_DOCS_MAX_SECTIONS = 3;
export const NODAL_DOCS_MAX_CHARS = 1200;

export const nodalDocsTool: ToolDefinition<typeof NodalDocsInputSchema, NodalDocsSection[]> = {
  name: 'nodal_docs',
  description:
    'Search the Nodal-Agents product documentation — the platform you are running inside. ' +
    'Returns the best two or three passages, each with the page it comes from and its URL. ' +
    'Use it BEFORE telling anyone that something is unsupported, impossible, or needs to be ' +
    'built: channels (Telegram, Discord, Slack, WhatsApp), automations, projects, approvals, ' +
    'memory, connectors and every dashboard screen are documented here. Use it to answer ' +
    '"how do I ..." with the exact place in the dashboard rather than a general description. ' +
    'Offline and instant: it reads an index shipped with the product, no network, no model.',
  inputSchema: NodalDocsInputSchema,
  riskLevel: 'read',
  card: 'search',
  present: ({ input, output }) =>
    searchCard({
      query: input.question,
      hits: output.map((s) => ({
        title: s.title,
        ref: s.url,
        snippet: s.page,
      })),
    }),
  execute: (input) => {
    // Throws DocsIndexUnavailableError when the index is missing — loud, with
    // the paths it probed. A tool that quietly returned "no results" would look
    // exactly like a question the documentation does not answer (invariant #4).
    const index = loadDocsIndex();
    const hits = searchDocs(index, input.question, NODAL_DOCS_MAX_SECTIONS);
    return Promise.resolve(
      hits.map((h) => ({
        title: h.heading,
        page: h.pageTitle,
        url: h.url,
        text: clip(h.text, NODAL_DOCS_MAX_CHARS),
      })),
    );
  },
};
