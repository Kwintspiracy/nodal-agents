// Root-agent types and helpers — Wave 1 (V4 ROOT agent, 2026-05-29).
// Pure module: no DB import, no side effects.

import { z } from 'zod';

// ─── AutonomyLevel ────────────────────────────────────────────────────────────

export type AutonomyLevel = 'propose_confirm' | 'destructive_gate' | 'fully_autonomous';

const AutonomyLevelSchema = z.enum(['propose_confirm', 'destructive_gate', 'fully_autonomous']);

// ─── RootGrants ───────────────────────────────────────────────────────────────

export interface RootGrants {
  createAgent: boolean;
  updateAgent: boolean;
  attachAgent: boolean;
  createSkill: boolean;
  updateSkill: boolean;
  assignSkill: boolean;
  createMcp: boolean;
  attachMcp: boolean;
  createConnector: boolean;
  attachConnector: boolean;
  manageSchedules: boolean;
  autonomy: AutonomyLevel;
}

const RootGrantsSchema = z.object({
  createAgent: z.boolean(),
  updateAgent: z.boolean(),
  attachAgent: z.boolean(),
  createSkill: z.boolean(),
  updateSkill: z.boolean(),
  assignSkill: z.boolean(),
  createMcp: z.boolean(),
  attachMcp: z.boolean(),
  createConnector: z.boolean(),
  attachConnector: z.boolean(),
  manageSchedules: z.boolean(),
  autonomy: AutonomyLevelSchema,
});

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_ROOT_GRANTS: RootGrants = {
  createAgent: true,
  updateAgent: true,
  attachAgent: true,
  createSkill: true,
  updateSkill: true,
  assignSkill: true,
  createMcp: true,
  attachMcp: true,
  createConnector: true,
  attachConnector: true,
  manageSchedules: true,
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
  updateAgent: false,
  attachAgent: false,
  createSkill: false,
  updateSkill: false,
  assignSkill: false,
  createMcp: false,
  attachMcp: false,
  createConnector: false,
  attachConnector: false,
  manageSchedules: false,
  autonomy: 'propose_confirm',
};

// ─── Meta-tool mapping ────────────────────────────────────────────────────────

/**
 * Meta-tool name(s) per grant key. A grant may enable a SET of tools: the
 * attach grants also enable their `detach_*` mirror (one toggle = manage that
 * link both ways), and `manageSchedules` enables the full cron CRUD. This keeps
 * the grant surface bounded instead of one toggle per tool.
 */
export const META_TOOL_BY_GRANT = {
  createAgent: 'create_agent',
  updateAgent: 'update_agent',
  attachAgent: ['attach_agent', 'detach_agent'],
  createSkill: 'create_skill',
  updateSkill: 'update_skill',
  assignSkill: ['attach_skill', 'detach_skill'],
  createMcp: 'create_mcp',
  attachMcp: ['attach_mcp', 'detach_mcp'],
  createConnector: 'create_connector',
  attachConnector: ['attach_connector', 'detach_connector'],
  manageSchedules: ['create_schedule', 'update_schedule', 'toggle_schedule', 'run_schedule'],
} as const;

export const META_TOOL_NAMES = [
  'create_agent',
  'update_agent',
  'attach_agent',
  'detach_agent',
  'create_skill',
  'update_skill',
  'attach_skill',
  'detach_skill',
  'create_mcp',
  'attach_mcp',
  'detach_mcp',
  'create_connector',
  'attach_connector',
  'detach_connector',
  'create_schedule',
  'update_schedule',
  'toggle_schedule',
  'run_schedule',
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the names of the meta-tools whose grant is enabled (flattened — a
 * grant may map to several tool names). */
export function enabledMetaTools(grants: RootGrants): string[] {
  return (Object.keys(META_TOOL_BY_GRANT) as Array<keyof typeof META_TOOL_BY_GRANT>)
    .filter((key) => grants[key] === true)
    .flatMap((key) => {
      const v = META_TOOL_BY_GRANT[key];
      return Array.isArray(v) ? [...v] : [v];
    });
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
  // updateAgent: editing an existing agent (model/personality) is additive +
  // reversible like createAgent, so existing ROOTs get it automatically (absent → TRUE).
  const updateAgent =
    typeof src['updateAgent'] === 'boolean' ? src['updateAgent'] : DEFAULT_ROOT_GRANTS.updateAgent;
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
  // attach grants travel with their create counterpart: when absent (a ROOT
  // configured before they existed) they inherit createMcp/createConnector, so a
  // ROOT that could create an MCP/connector can also attach it (never the broken
  // "create but can't attach" state).
  const attachMcp = typeof src['attachMcp'] === 'boolean' ? src['attachMcp'] : createMcp;
  const attachConnector =
    typeof src['attachConnector'] === 'boolean' ? src['attachConnector'] : createConnector;
  // manageSchedules is a new capability (agent creates/edits its own crons —
  // recurring, cost-bearing): absent → FALSE, explicit opt-in only.
  const manageSchedules =
    typeof src['manageSchedules'] === 'boolean' ? src['manageSchedules'] : false;
  const autonomyParsed = AutonomyLevelSchema.safeParse(src['autonomy']);
  const autonomy = autonomyParsed.success ? autonomyParsed.data : DEFAULT_ROOT_GRANTS.autonomy;

  return {
    createAgent,
    updateAgent,
    attachAgent,
    createSkill,
    updateSkill,
    assignSkill,
    createMcp,
    attachMcp,
    createConnector,
    attachConnector,
    manageSchedules,
    autonomy,
  };
}
