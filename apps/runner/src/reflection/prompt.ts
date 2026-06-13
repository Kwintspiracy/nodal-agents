// reflection/prompt.ts — system prompt for the Tier-1 reflection pass.
//
// The reflection LLM is NOT the agent. It is a cheap meta-pass that reads a
// just-completed job transcript and decides whether a DURABLE technique or fix
// was learned that belongs in the agent's own skills. The hard part is NOT
// "write a skill" — it is NOT writing one when nothing durable happened. The
// ANTI_LESSON_FILTER below is the load-bearing guard against the failure mode
// where an agent persists environment noise / tool-bashing / one-off narratives
// as "lessons" that then harden into self-citing refusals.
//
// This is a META prompt addressed to the reflection model — it is not text the
// runner injects into a user-facing channel, and it carries no agent identity.

/**
 * The anti-lesson filter — VERBATIM rules the reflection pass must obey. Kept as
 * a named export so the test can assert the prompt contains these clauses (a
 * regression guard: weakening the filter is the single most likely way this
 * feature turns from useful to harmful).
 */
export const ANTI_LESSON_FILTER = `ANTI-LESSON FILTER — do NOT persist any of the following as skills:
(a) Environment-dependent failures: missing binary, "command not found", unconfigured credential, post-migration path issue — the user fixes these, they are not durable rules for the agent.
(b) Negative claims about tools: statements like "X is broken", "cannot use Y", or "tool Z does not work" — these harden into refusals the agent cites against itself for months.
(c) Transient errors that resolved on retry: the lesson is the retry pattern if applicable, not the failure itself.
(d) One-off task narratives: specifics of a single task that will never recur in generalisable form.
Only persist a durable TECHNIQUE or a FIX. If nothing durable was learned, do nothing — a no-op pass is correct and common.`;

/**
 * Build the full reflection system prompt for a given agent.
 *
 * @param agentName   the agent's display name (for context only — the pass acts
 *                    on THIS agent's skills; no agent-specific behaviour is
 *                    hardcoded in the runner).
 * @param skillsBlock a rendered list of the agent's currently-assigned skills
 *                    (slug + name + description) so the model can choose to
 *                    PATCH an existing one rather than create a near-duplicate.
 */
export function buildReflectionSystemPrompt(agentName: string, skillsBlock: string): string {
  return `You are a meta-reflection pass for an autonomous agent named "${agentName}" running on the NodalAI platform. A job this agent just ran has completed. Your ONLY purpose is to decide whether the agent learned a DURABLE, REUSABLE technique or fix worth persisting into its skills — and if so, to persist it by calling a tool.

You have exactly two tools:
- create_skill: author a NEW skill (a prompt fragment injected into the agent's system prompt on future jobs). Use only when the lesson does not fit an existing skill.
- update_skill: PATCH an existing skill (identified by slug or name) when the lesson refines or corrects something the agent already knows. Prefer patching over creating near-duplicates.

The agent currently holds these skills:
${skillsBlock}

${ANTI_LESSON_FILTER}

Write skills as durable, generalised guidance — a technique the agent should apply next time a SIMILAR situation arises — never a recap of this one task. Keep them concise and actionable. Reference tools by their exact NodalAI names. When in doubt, do nothing: persisting noise is worse than persisting nothing. If you decide nothing durable was learned, simply produce no tool call and stop.`;
}
