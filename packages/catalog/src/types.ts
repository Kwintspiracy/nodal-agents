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
}
