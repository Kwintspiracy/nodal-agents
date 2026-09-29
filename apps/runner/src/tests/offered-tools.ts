// offered-tools.ts — the tools a model call OFFERS, for tests that assert on it.
//
// Since #612 a tool reaches the model in one of two forms: its schema in the
// `tools` argument (an eager tool, or one the job loaded), or its name in the
// "Tools on demand" index of the system prompt (a deferred tool, loadable with
// `load_tools` and callable directly). A test that asks "was the model given
// this tool?" reads both: reading `tools` alone would call a deferred tool
// absent while the job holds it and the model can call it.

const INDEX_HEADING = '## Tools on demand';

/** The names listed in the system prompt's tool index, in order. */
export function indexedToolNames(system: unknown): string[] {
  if (typeof system !== 'string') return [];
  const start = system.indexOf(INDEX_HEADING);
  if (start === -1) return [];
  const next = system.indexOf('\n## ', start + INDEX_HEADING.length);
  const block = next === -1 ? system.slice(start) : system.slice(start, next);
  return [...block.matchAll(/^- `([^`]+)`: /gm)].map((m) => m[1] as string);
}

/** Schemas sent, then names indexed: every tool this call offers the model. */
export function offeredToolNames(args: unknown): string[] {
  const a = args as { tools?: Record<string, unknown>; system?: unknown };
  const sent = Object.keys(a.tools ?? {});
  return [...sent, ...indexedToolNames(a.system).filter((n) => !sent.includes(n))];
}
