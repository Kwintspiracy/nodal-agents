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
// Deliberately distinctive so it can never collide with real prompt text.
export const SYSTEM_PROMPT_CACHE_BOUNDARY = '\n\n[[[NODAL_SYSTEM_CACHE_BOUNDARY]]]\n\n';
