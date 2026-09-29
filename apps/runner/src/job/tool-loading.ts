// tool-loading.ts — which tool SCHEMAS a job's turn sends (#612).
//
// The whitelist decides what a job may call; this module decides only what
// the model READS. Every tool of the whitelist stays callable on every turn:
// the job's tool map is the whitelist, whole. The request carries the `eager`
// tools, then the deferred tools the transcript has loaded.
//
// The transcript is the record, never a counter in memory: a deferred tool is
// loaded once an assistant turn called `load_tools` with its name, or called
// it directly. A resume (approval, delegation, restart) re-reads the same
// messages and sends the same list, and a tool a stored `tool-call` part names
// is always offered again — no provider sees a call to a tool it was never
// given.
//
// Order is part of the prompt cache: eager tools in whitelist order, then the
// loaded ones in the order the transcript first names them. Loading appends,
// nothing is ever removed, so a turn that loads nothing sends the byte-same
// list as the turn before. A load itself changes the list once — the price
// the Anthropic and OpenAI tool searches avoid only by expanding definitions
// server-side, which a provider-neutral runner cannot do.

import type { ModelMessage } from 'ai';
import { LOAD_TOOLS_NAME, isEagerTool } from '@nodal-agents/tools';

/**
 * The deferred tools this transcript has loaded, in the order it first names
 * them. `deferred` is the job's own set: a name outside it loads nothing,
 * whatever a `load_tools` call asked for.
 */
export function toolsLoadedByTranscript(
  messages: readonly ModelMessage[],
  deferred: ReadonlySet<string>,
): string[] {
  const loaded: string[] = [];
  const add = (name: unknown): void => {
    if (typeof name === 'string' && deferred.has(name) && !loaded.includes(name)) {
      loaded.push(name);
    }
  };
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== 'tool-call') continue;
      if (part.toolName === LOAD_TOOLS_NAME) {
        const names = (part.input as { names?: unknown } | null)?.names;
        if (Array.isArray(names)) for (const n of names) add(n);
      } else {
        add(part.toolName);
      }
    }
  }
  return loaded;
}

/** The job's deferred tool names: every tool of the whitelist not declared `eager`. */
export function deferredToolNames<T extends { name: string; loading?: 'eager' | 'deferred' }>(
  tools: readonly T[],
): Set<string> {
  return new Set(tools.filter((t) => !isEagerTool(t)).map((t) => t.name));
}

/**
 * The tools whose schemas this turn sends: the eager ones, in whitelist
 * order, then the loaded ones, in load order.
 */
export function toolsSentThisTurn<T extends { name: string; loading?: 'eager' | 'deferred' }>(
  tools: readonly T[],
  messages: readonly ModelMessage[],
): T[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const loaded = toolsLoadedByTranscript(messages, deferredToolNames(tools));
  return [
    ...tools.filter((t) => isEagerTool(t)),
    ...loaded.map((n) => byName.get(n)).filter((t): t is T => t !== undefined),
  ];
}
