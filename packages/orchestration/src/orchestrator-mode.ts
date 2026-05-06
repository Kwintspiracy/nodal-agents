// orchestrator-mode.ts — detect whether an agent is router / planner / worker
// Data-driven from DB child list. Never hardcoded by name.

import type { OrchestratorMode, Agent, ChildAgent } from './types';

/**
 * Detect the orchestration mode for an agent based on its children.
 *
 * - router:  has at least one sub-orchestrator child
 * - planner: has at least one worker child (but no sub-orchestrators)
 * - worker:  no children at all
 *
 * Mirrors the legacy Python logic in jobs.py:
 *   `has_sub_orchestrators = any(a["role"] == "orchestrator" for a in agents_list)`
 *   `is_router = has_sub_orchestrators`
 *
 * The agent's explicit `orchestratorMode` field (if set in DB) takes precedence.
 * This allows an operator to pin an orchestrator as 'planner' even if it has
 * sub-orchestrator children (unusual but valid).
 */
export function detectOrchestratorMode(
  agent: Pick<Agent, 'role' | 'orchestratorMode'>,
  children: Pick<ChildAgent, 'role'>[],
): OrchestratorMode {
  // Non-orchestrator agents are always workers
  if (agent.role !== 'orchestrator') {
    return 'worker';
  }

  // If the DB has an explicit override, honour it
  if (agent.orchestratorMode === 'router') return 'router';
  if (agent.orchestratorMode === 'planner') return 'planner';

  // Auto-detect from children
  if (children.length === 0) {
    // Orchestrator with no children configured — treat as worker (misconfigured)
    return 'worker';
  }

  const hasSubOrchestrators = children.some((c) => c.role === 'orchestrator');
  if (hasSubOrchestrators) return 'router';

  return 'planner';
}
