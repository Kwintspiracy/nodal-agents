// @nodal-agents/catalog types.ts — canonical types for the product catalog
//
// The catalog is the source of truth for the system skills that ship with
// NodalAI out of the box. At boot, the skill seeder upserts each catalog
// entry into the DB so every install of the same npm version has the same
// set of system skills.
//
// Runtime still reads from the DB — invariant #1 (no hardcoded agent
// metadata) is preserved. The catalog is data-as-code purely for the
// install-time bootstrap, exactly like `seedDefaultLlmKey` reads env to
// seed the first row.
//
// Scope: skills only. Agents are never shipped — every agent is user-created.

/**
 * Behavior layer of a system skill — drives where it is injected and whether
 * the user manages it:
 * - `baseline`: intrinsic discipline injected into EVERY agent's base prompt
 *   (e.g. verify-before-done, safe-tool-use, language-mirror). Not assignable,
 *   hidden from the library — it is part of every agent by default.
 * - `channel`: injected automatically when the agent is bound to a channel
 *   (e.g. telegram formatting etiquette). Not assignable.
 * - `capability`: opt-in capability/domain skill the user assigns when relevant
 *   (obsidian, office-editing, …). Shown in the library + discoverable by the
 *   agent (it knows the skill exists even when unassigned).
 * - `agent-internal`: loaded on demand via skill_view (the per-meta-tool usage
 *   guides). Hidden from the library, still documented.
 */
export type SkillKind = 'baseline' | 'channel' | 'capability' | 'agent-internal';

/** Skill that ships with the product. */
export interface SystemSkill {
  /** Stable identifier used for tool naming + assignment lookups. */
  slug: string;
  /** Display name in the dashboard. */
  name: string;
  /** One-line description shown in the dashboard skill picker. */
  description: string;
  /** Markdown body injected into the system prompt of agents that own this skill. */
  content: string;
  /** Tool names this skill needs the agent to have access to (whitelist hint). */
  requiredBuiltins?: string[];
  /** Behavior layer (see SkillKind). Defaults to 'capability' when omitted. */
  kind?: SkillKind;
}
