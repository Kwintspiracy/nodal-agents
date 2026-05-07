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
 *
 * @param input           Agent identity + configured tool names.
 * @param registry        The tool registry to look up definitions from.
 * @param capabilityTools Extra ToolDefinitions already registered for this
 *                        agent based on its capabilities (e.g. telegram_send_message
 *                        when telegramBotToken is set). Merged after configuredTools
 *                        and alwaysOn; duplicates are deduplicated by name.
 */
export function computeToolWhitelist(
  input: WhitelistInput,
  registry: ToolRegistry,
  capabilityTools: ToolDefinition<z.ZodTypeAny, unknown>[] = [],
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
  const baseDefs = allNames.map((name) => {
    const def = registry.get(name);
    // We already verified all names exist above — this cast is safe
    return def as ToolDefinition<z.ZodTypeAny, unknown>;
  });

  // Merge capability tools, deduplicating by name (capability tool wins if same name)
  const baseNames = new Set(allNames);
  const extraDefs = capabilityTools.filter((t) => !baseNames.has(t.name));

  return [...baseDefs, ...extraDefs];
}
