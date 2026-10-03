// @nodal-agents/shared — system-prompt cache boundary marker.
//
// buildSystemPrompt (orchestration) places this marker between the STABLE part
// of the system prompt (personality, skills, capabilities — byte-identical
// across a given agent's jobs) and the VOLATILE tail (live timestamp, per-task
// memory ranking, per-job context). The Anthropic caching layer (llm) splits on
// it so the stable prefix gets its own ephemeral cache breakpoint and is reused
// across jobs within the cache window, while the volatile tail stays fresh
// (E1, audit followup). Providers without caching strip the marker before send.
//
// Deliberately distinctive, but the prompt also carries text Nodal did not
// write (an agent's personality, a skill, an MCP server's guidance, memory, a
// workspace listing): that text can contain it. defuseSystemCacheBoundary is
// applied to each half before the marker is placed, so the only marker a
// prompt carries is the one buildSystemPrompt put there.
export const SYSTEM_PROMPT_CACHE_BOUNDARY = '\n\n[[[NODAL_SYSTEM_CACHE_BOUNDARY]]]\n\n';

const BOUNDARY_TOKEN = /\[\[\[NODAL_SYSTEM_CACHE_BOUNDARY\]\]\]/g;

/** Text that is not the builder's own loses the marker's brackets, and nothing else. */
export function defuseSystemCacheBoundary(text: string): string {
  return text.replace(BOUNDARY_TOKEN, '[NODAL_SYSTEM_CACHE_BOUNDARY]');
}
