// @nodal-agents/tools — per-agent tool whitelist computation
// Invariant 9: every agent's tool list is explicit. No undeclared defaults.

import type { z } from 'zod';
import type { ToolDefinition, ToolRegistry } from './types';
import { WhitelistDriftError } from './errors';
import { ALWAYS_ON_TOOLS } from './builtin/index';

/**
 * What decides an agent's BUILT-IN tools: its tool groups, its authorizations,
 * its root grants, and where the job sits. Read from the database by each
 * caller; the rule applied to it lives in `agentBuiltinToolNames`, once.
 */
export interface AgentBuiltinInput {
  /** `required_builtins` of every tool group the agent holds (agent_skills). */
  requiredBuiltins: readonly string[];
  /** At least one of its skills has owner-authorized scripts. */
  scriptsAuthorized: boolean;
  /** At least one of its skills has owner-authorized writable files. */
  filesWritable: boolean;
  /** Root meta-tools its grants serve (empty for a non-root agent). */
  metaToolNames: readonly string[];
  job: {
    /** Delegated by another job (`agent_jobs.parent_job_id` set). */
    delegated: boolean;
    /** Run of a routine (`agent_jobs.schedule_id` set). */
    routine: boolean;
    /** Turn of a conversation (`agent_jobs.conversation_id` set). */
    inConversation: boolean;
  };
}

/**
 * The built-in tool names of a job, in whitelist order — the SAME list for
 * every agent, whatever its role (#636). The orchestrator role ADDS its
 * delegation tools on top (execute.ts); it never takes anything away.
 *
 * Before, the orchestrator branch of the job whitelist skipped the tool
 * groups: the Tools tab showed "Spreadsheet editing" ON for the root, and the
 * runner gave it no `xlsx_*`, in silence.
 *
 * Order is part of the prompt cache (#612): always-on first, then the groups'
 * builtins, then the gated ones. A name the registry does not hold is dropped
 * for the groups (a group may name a builtin this build does not register);
 * everything else must be registered — `computeToolWhitelist` fails loud.
 */
export function agentBuiltinToolNames(input: AgentBuiltinInput, registry: ToolRegistry): string[] {
  const { job } = input;
  // P5 (causality study, 2026-07-22): a delegated job delivers NOTHING to the
  // user directly — the agent that owns the channel binding is the sole
  // delivery path. Its channel sends are already absent (no inherited token);
  // dashboard_publish is always-on and is removed here, for a delegated worker
  // and a delegated orchestrator alike.
  const alwaysOn: string[] = job.delegated
    ? ALWAYS_ON_TOOLS.filter((n) => n !== 'dashboard_publish')
    : [...ALWAYS_ON_TOOLS];
  return [
    ...new Set([
      ...alwaysOn,
      ...input.requiredBuiltins.filter((n) => registry.get(n) !== undefined),
      ...input.metaToolNames,
      // run_skill_script / skill_file_write — only with an owner authorization;
      // the builtin checks it again at execution.
      ...(input.scriptsAuthorized ? ['run_skill_script'] : []),
      ...(input.filesWritable ? ['skill_file_write'] : []),
      // save_routine_state — the other half of the prompt's `## Routine state`.
      ...(job.routine ? ['save_routine_state'] : []),
      // list/stop_conversation_run (#567) — for the job that speaks to the
      // person; stopping the person's other runs is not a delegate's work.
      ...(job.inConversation && !job.delegated
        ? ['list_conversation_runs', 'stop_conversation_run']
        : []),
    ]),
  ];
}

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
