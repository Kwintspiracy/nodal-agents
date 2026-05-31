// Root-agent types and helpers — Wave 1 (V4 ROOT agent, 2026-05-29).
// Pure module: no DB import, no side effects.

import { z } from 'zod';

// ─── AutonomyLevel ────────────────────────────────────────────────────────────

export type AutonomyLevel = 'propose_confirm' | 'destructive_gate' | 'fully_autonomous';

const AutonomyLevelSchema = z.enum(['propose_confirm', 'destructive_gate', 'fully_autonomous']);

// ─── RootGrants ───────────────────────────────────────────────────────────────

export interface RootGrants {
  createAgent: boolean;
  createSkill: boolean;
  updateSkill: boolean;
  assignSkill: boolean;
  autonomy: AutonomyLevel;
}

const RootGrantsSchema = z.object({
  createAgent: z.boolean(),
  createSkill: z.boolean(),
  updateSkill: z.boolean(),
  assignSkill: z.boolean(),
  autonomy: AutonomyLevelSchema,
});

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_ROOT_GRANTS: RootGrants = {
  createAgent: true,
  createSkill: true,
  updateSkill: true,
  assignSkill: true,
  autonomy: 'propose_confirm',
};

// ─── Meta-tool mapping ────────────────────────────────────────────────────────

/** Meta-tool name per grant key. */
export const META_TOOL_BY_GRANT = {
  createAgent: 'create_agent',
  createSkill: 'create_skill',
  updateSkill: 'update_skill',
  assignSkill: 'attach_skill',
} as const;

export const META_TOOL_NAMES = [
  'create_agent',
  'create_skill',
  'update_skill',
  'attach_skill',
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the names of the meta-tools whose grant is enabled. */
export function enabledMetaTools(grants: RootGrants): string[] {
  return (Object.keys(META_TOOL_BY_GRANT) as Array<keyof typeof META_TOOL_BY_GRANT>)
    .filter((key) => grants[key] === true)
    .map((key) => META_TOOL_BY_GRANT[key]);
}

/**
 * Parse an unknown JSONB value into RootGrants, falling back to
 * DEFAULT_ROOT_GRANTS for missing or invalid fields. Never throws.
 */
export function parseRootGrants(raw: unknown): RootGrants {
  const result = RootGrantsSchema.safeParse(raw);
  if (result.success) return result.data;

  // Partial fallback: try to salvage individual fields from the raw object.
  const src = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const createAgent =
    typeof src['createAgent'] === 'boolean' ? src['createAgent'] : DEFAULT_ROOT_GRANTS.createAgent;
  const createSkill =
    typeof src['createSkill'] === 'boolean' ? src['createSkill'] : DEFAULT_ROOT_GRANTS.createSkill;
  const updateSkill =
    typeof src['updateSkill'] === 'boolean' ? src['updateSkill'] : DEFAULT_ROOT_GRANTS.updateSkill;
  const assignSkill =
    typeof src['assignSkill'] === 'boolean' ? src['assignSkill'] : DEFAULT_ROOT_GRANTS.assignSkill;
  const autonomyParsed = AutonomyLevelSchema.safeParse(src['autonomy']);
  const autonomy = autonomyParsed.success ? autonomyParsed.data : DEFAULT_ROOT_GRANTS.autonomy;

  return { createAgent, createSkill, updateSkill, assignSkill, autonomy };
}
