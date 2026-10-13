// tool-loading.ts — which tool SCHEMAS a job's turn sends (#612).
//
// The whitelist decides what a job may call; this module decides only what
// the model READS. Every tool of the whitelist stays callable on every turn:
// the job's tool map is the whitelist, whole. The request carries the `eager`
// tools, then the deferred tools the job has loaded.
//
// What a job loaded is STATE, kept on its row (`agent_jobs.loaded_tools`), in
// load order: the names a `load_tools` call asked for, and every deferred tool
// called directly. It cannot live in the transcript: context compaction
// replaces a large tool-call input with a marker, and the names a load asked
// for went with it (review of #616). A resume (approval, delegation, restart)
// reads the same row and sends the same list.
//
// The transcript still has a say, for one reason only: a tool a stored
// `tool-call` part names is always offered again, so no provider sees a call
// to a tool it was never given. Its tool NAME survives any compaction.
//
// Order is part of the prompt cache: eager tools in whitelist order, then the
// loaded ones in load order. Loading appends, nothing is ever removed, so a
// turn that loads nothing sends the byte-same list as the turn before. A load
// itself changes the list once — the price the Anthropic and OpenAI tool
// searches avoid only by expanding definitions server-side, which a
// provider-neutral runner cannot do.

import type { ModelMessage } from 'ai';
import { LOAD_TOOLS_NAME, isEagerTool, namesAskedToLoad } from '@nodal-agents/tools';

type Loadable = { name: string; loading?: 'eager' | 'deferred' };

/** The job's deferred tool names: every tool of the whitelist not declared `eager`. */
export function deferredToolNames(tools: readonly Loadable[]): Set<string> {
  return new Set(tools.filter((t) => !isEagerTool(t)).map((t) => t.name));
}

/**
 * The deferred tools a turn's calls load beyond `already`, in call order: the
 * names a `load_tools` call asks for (read by the loader's own reading), and a
 * deferred tool called directly. A name outside `deferred` loads nothing.
 */
export function toolsLoadedByCalls(
  calls: ReadonlyArray<{ name: string; input: unknown }>,
  deferred: ReadonlySet<string>,
  already: readonly string[],
): string[] {
  const added: string[] = [];
  const add = (name: string): void => {
    if (deferred.has(name) && !already.includes(name) && !added.includes(name)) added.push(name);
  };
  for (const call of calls) {
    if (call.name === LOAD_TOOLS_NAME) namesAskedToLoad(call.input).forEach(add);
    else add(call.name);
  }
  return added;
}

/** The deferred tools the transcript's tool-call parts name, in order. */
export function toolsCalledInTranscript(
  messages: readonly ModelMessage[],
  deferred: ReadonlySet<string>,
): string[] {
  const named: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'tool-call' && deferred.has(part.toolName)) {
        if (!named.includes(part.toolName)) named.push(part.toolName);
      }
    }
  }
  return named;
}

/**
 * The tools whose schemas this turn sends: the eager ones, in whitelist
 * order, then the loaded ones, in load order, then any other deferred tool the
 * transcript calls.
 */
export function toolsSentThisTurn<T extends Loadable>(
  tools: readonly T[],
  loaded: readonly string[],
  messages: readonly ModelMessage[],
): T[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const deferred = deferredToolNames(tools);
  const extra = toolsCalledInTranscript(messages, deferred).filter((n) => !loaded.includes(n));
  return [
    ...tools.filter((t) => isEagerTool(t)),
    ...[...loaded, ...extra]
      .filter((n) => deferred.has(n))
      .map((n) => byName.get(n))
      .filter((t): t is T => t !== undefined),
  ];
}
