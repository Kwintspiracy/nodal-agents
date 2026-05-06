// @nodalai/tools — per-agent tool whitelist computation
// Invariant 9: every agent's tool list is explicit. No undeclared defaults.

import type { z } from 'zod';
import type { ToolDefinition, ToolRegistry } from './types';
import { WhitelistDriftError } from './errors';

export interface WhitelistInput {
  agentId: string;
  /**
   * Tools the agent has explicit access to, derived from agent_skills +
   * skill_assignments + connectors in the DB.
   */
  configuredTools: string[];
  /**
   * Always-on tool names appended unconditionally (e.g. return_result,
   * save_memory, query_memory). These still must be in the registry —
   * drift detection applies here too.
   */
  alwaysOn?: string[];
}

/**
 * Compute the exact set of ToolDefinitions an agent may invoke.
 *
 * Throws WhitelistDriftError if any tool name (from configuredTools or
 * alwaysOn) is not present in the registry. This surfaces wiring bugs
 * (e.g. adapter not registered, typo in skill assignment) at startup
 * rather than silently exposing zero tools or falling back to defaults.
 */
export function computeToolWhitelist(
  input: WhitelistInput,
  registry: ToolRegistry,
): ToolDefinition<z.ZodTypeAny, unknown>[] {
  const { agentId, configuredTools, alwaysOn = [] } = input;

  // Deduplicate: alwaysOn wins, but no duplicates in final list
  const allNames = Array.from(new Set([...configuredTools, ...alwaysOn]));

  // Drift detection: every name must exist in the registry
  const missing = allNames.filter((name) => registry.get(name) === undefined);
  if (missing.length > 0) {
    throw new WhitelistDriftError(agentId, missing);
  }

  // Map names → definitions (order: configuredTools first, then alwaysOn additions)
  return allNames.map((name) => {
    const def = registry.get(name);
    // We already verified all names exist above — this cast is safe
    return def as ToolDefinition<z.ZodTypeAny, unknown>;
  });
}
