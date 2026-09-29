// Built-in: load_tools — the schemas of a job's deferred tools, on demand (#612).
//
// A job holds its whole whitelist, but the model reads only the schemas of the
// `eager` tools on each turn. The others are named, one line each, in the
// prompt's tool index, and this tool adds their schemas to the following
// turns. It loads nothing the job does not already hold: the names it accepts
// are the job's own deferred tools, fixed when the job builds its list
// (invariant #9 unchanged, it can only narrow).
//
// Same form as the tool search of the Anthropic and OpenAI APIs
// (`defer_loading`): the definition is sent only once the model asks for it.
// Those APIs expand it inline in the conversation; a provider-neutral runner
// cannot, so the runner appends the loaded schemas at the END of the tool list
// from the next turn on, and never removes one — what the transcript already
// used stays callable (apps/runner/src/job/tool-loading.ts).
//
// The tool itself decides nothing about what is sent: the transcript is the
// record. A `load_tools` call, like a direct call to a deferred tool, is read
// back from the job's messages on every turn, so a resume after an approval,
// a delegation or a restart sends exactly what the model last saw.

import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const LOAD_TOOLS_NAME = 'load_tools';

/** The longest line a tool gets in the index: its first sentence, cut here. */
const INDEX_LINE_MAX = 160;

export const LoadToolsInputSchema = z.object({
  names: z
    .array(z.string().min(1))
    .min(1)
    .describe('Exact names of the tools to load, as written in your tool index.'),
});

export type LoadToolsInput = z.infer<typeof LoadToolsInputSchema>;

export type LoadToolsOutput = {
  /** Deferred tools of this job, now loaded. */
  loaded: string[];
  /** Tools whose definition was already in the request. */
  alreadyAvailable: string[];
  /** Names this job does not hold: nothing is loaded for them. */
  notHeld: string[];
  message: string;
};

/** A tool as the index and the loader need to see it. */
export interface LoadableTool {
  name: string;
  description: string;
  loading?: 'eager' | 'deferred';
}

/** True when the model receives this tool's schema on every turn. */
export function isEagerTool(tool: { loading?: 'eager' | 'deferred' }): boolean {
  return tool.loading === 'eager';
}

/**
 * The one line a deferred tool gets in the prompt's index: the first sentence
 * of the description the model would read anyway, never a second text to keep
 * in sync (invariant #1).
 */
export function toolIndexLine(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length <= INDEX_LINE_MAX
    ? sentence
    : sentence.slice(0, INDEX_LINE_MAX - 1).trimEnd() + '…';
}

export interface ToolIndexEntry {
  name: string;
  line: string;
}

/** The index entries of a tool list: its deferred tools, in list order. */
export function deferredToolIndex(tools: readonly LoadableTool[]): ToolIndexEntry[] {
  return tools
    .filter((t) => !isEagerTool(t))
    .map((t) => ({ name: t.name, line: toolIndexLine(t.description) }));
}

/**
 * The `load_tools` of ONE job, built from that job's tool list.
 *
 * `tools` is the job's whole whitelist. Loading a name outside it answers
 * `notHeld` and loads nothing, whatever the name is.
 */
export function createLoadToolsTool(
  tools: readonly LoadableTool[],
): ToolDefinition<typeof LoadToolsInputSchema, LoadToolsOutput> {
  const deferred = new Set(tools.filter((t) => !isEagerTool(t)).map((t) => t.name));
  const eager = new Set(tools.filter((t) => isEagerTool(t)).map((t) => t.name));
  return {
    name: LOAD_TOOLS_NAME,
    label: 'Load tool definitions',
    summary:
      'Add the full definition of one of its own tools to what the agent reads. It gives the agent no new tool.',
    description:
      'Load the full definitions of tools listed in your tool index, so you can call them. ' +
      'Your tool index names tools you already hold whose definitions are not in this request yet. ' +
      'Pass every name you need in one call; they are available from your next step on. ' +
      'Only tools from your index can be loaded.',
    inputSchema: LoadToolsInputSchema,
    riskLevel: 'read',
    loading: 'eager',
    card: 'text',
    execute: async (input) => {
      const asked = [...new Set(input.names.map((n) => n.trim()))];
      const loaded = asked.filter((n) => deferred.has(n));
      const alreadyAvailable = asked.filter((n) => eager.has(n) || n === LOAD_TOOLS_NAME);
      const notHeld = asked.filter(
        (n) => !deferred.has(n) && !eager.has(n) && n !== LOAD_TOOLS_NAME,
      );
      const parts: string[] = [];
      if (loaded.length > 0) {
        parts.push(
          `Loaded: ${loaded.join(', ')}. Their definitions are in your tool list from your next step on; call them directly.`,
        );
      }
      if (alreadyAvailable.length > 0) {
        parts.push(`Already in your tool list: ${alreadyAvailable.join(', ')}.`);
      }
      if (notHeld.length > 0) {
        parts.push(
          `Not tools you hold: ${notHeld.join(', ')}. Nothing was loaded for them; only the names in your tool index can be loaded.`,
        );
      }
      return { loaded, alreadyAvailable, notHeld, message: parts.join(' ') };
    },
  };
}
