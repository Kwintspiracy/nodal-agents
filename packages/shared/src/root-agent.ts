// Root-agent types and helpers — Wave 1 (V4 ROOT agent, 2026-05-29).
// Pure module: no DB import, no side effects.

import { z } from 'zod';

// ─── AutonomyLevel ────────────────────────────────────────────────────────────

export type AutonomyLevel = 'propose_confirm' | 'destructive_gate' | 'fully_autonomous';

const AutonomyLevelSchema = z.enum(['propose_confirm', 'destructive_gate', 'fully_autonomous']);

// ─── RootGrants ───────────────────────────────────────────────────────────────

export interface RootGrants {
  createAgent: boolean;
  attachAgent: boolean;
  createSkill: boolean;
  updateSkill: boolean;
  assignSkill: boolean;
  createMcp: boolean;
  createConnector: boolean;
  autonomy: AutonomyLevel;
}

const RootGrantsSchema = z.object({
  createAgent: z.boolean(),
  attachAgent: z.boolean(),
  createSkill: z.boolean(),
  updateSkill: z.boolean(),
  assignSkill: z.boolean(),
  createMcp: z.boolean(),
  createConnector: z.boolean(),
  autonomy: AutonomyLevelSchema,
});

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_ROOT_GRANTS: RootGrants = {
  createAgent: true,
  attachAgent: true,
  createSkill: true,
  updateSkill: true,
  assignSkill: true,
  createMcp: true,
  createConnector: true,
  autonomy: 'propose_confirm',
};

/**
 * Grants applied when an orchestrator is AUTO-designated ROOT — i.e. the first
 * orchestrator created in an entity (the "origin orchestrator" model).
 *
 * Distinct from DEFAULT_ROOT_GRANTS: manual designation was a deliberate act, so
 * starting all-on (behind approval) was fine. Auto-designation is passive — the
 * ROOT is set the moment you create your first orchestrator — so powers start
 * OFF. The agent is structurally ROOT (chat target + top of the hierarchy) but
 * holds no meta-tools until the user opts in per-grant in Settings → ROOT agent.
 *
 * All-off matters for safety: `enabledMetaTools()` returns [] so the ROOT
 * receives no meta-tools and no approval rules are required. (A null rootGrants
 * would instead parse to all-on via parseRootGrants — which is why auto-ROOT
 * must write these explicit grants.)
 */
export const INITIAL_AUTO_ROOT_GRANTS: RootGrants = {
  createAgent: false,
  attachAgent: false,
  createSkill: false,
  updateSkill: false,
  assignSkill: false,
  createMcp: false,
  createConnector: false,
  autonomy: 'propose_confirm',
};

// ─── Meta-tool mapping ────────────────────────────────────────────────────────

/** Meta-tool name per grant key. */
export const META_TOOL_BY_GRANT = {
  createAgent: 'create_agent',
  attachAgent: 'attach_agent',
  createSkill: 'create_skill',
  updateSkill: 'update_skill',
  assignSkill: 'attach_skill',
  createMcp: 'create_mcp',
  createConnector: 'create_connector',
} as const;

export const META_TOOL_NAMES = [
  'create_agent',
  'attach_agent',
  'create_skill',
  'update_skill',
  'attach_skill',
  'create_mcp',
  'create_connector',
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
  // attachAgent: when absent from a stored object (a ROOT configured before this
  // grant existed), fall back to the default (TRUE), mirroring createAgent and the
  // other benign roster/skill grants. Assigning an EXISTING agent as a sub-agent is
  // additive + reversible — not a new risk surface like create_mcp/create_connector
  // (which stay opt-in-false), so existing ROOTs get it automatically.
  const attachAgent =
    typeof src['attachAgent'] === 'boolean' ? src['attachAgent'] : DEFAULT_ROOT_GRANTS.attachAgent;
  const createSkill =
    typeof src['createSkill'] === 'boolean' ? src['createSkill'] : DEFAULT_ROOT_GRANTS.createSkill;
  const updateSkill =
    typeof src['updateSkill'] === 'boolean' ? src['updateSkill'] : DEFAULT_ROOT_GRANTS.updateSkill;
  const assignSkill =
    typeof src['assignSkill'] === 'boolean' ? src['assignSkill'] : DEFAULT_ROOT_GRANTS.assignSkill;
  // createMcp is a newer grant: when absent from a stored object (a ROOT
  // configured before this grant existed), fall back to FALSE — a new
  // capability must be explicitly opt-in, never retroactively granted
  // (which would expose an un-gated meta-tool on existing ROOTs).
  const createMcp = typeof src['createMcp'] === 'boolean' ? src['createMcp'] : false;
  const createConnector =
    typeof src['createConnector'] === 'boolean' ? src['createConnector'] : false;
  const autonomyParsed = AutonomyLevelSchema.safeParse(src['autonomy']);
  const autonomy = autonomyParsed.success ? autonomyParsed.data : DEFAULT_ROOT_GRANTS.autonomy;

  return {
    createAgent,
    attachAgent,
    createSkill,
    updateSkill,
    assignSkill,
    createMcp,
    createConnector,
    autonomy,
  };
}
