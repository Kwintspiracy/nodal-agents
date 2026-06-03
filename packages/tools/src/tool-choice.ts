// @nodal-agents/tools — tool_choice discipline
// Encodes the pitfall from CLAUDE.md:
//   "tool_choice forced 'required' on turn 1 for orchestrators and agents
//    with adapter tools. Without this, GPT models may produce text-only
//    output and skip tool calls."

export interface ToolChoiceConfig {
  /**
   * True if this is the first turn AND the agent is an orchestrator
   * (router or planner). Orchestrators must call a tool on turn 1
   * to start the delegation or planning flow.
   */
  isOrchestrator: boolean;

  /**
   * Current turn number (1-indexed).
   * Turn 1 triggers force for orchestrators.
   */
  turn: number;

  /**
   * True if the agent has any adapter-provided tools (e.g. notion_*, drive_*,
   * gmail_*, etc.). Worker agents with adapter tools must always call a tool
   * so they can't drift into prose mid-task — return_result is also a tool,
   * so they can always close the loop.
   */
  hasAdapterTools: boolean;

  /**
   * Per-model capability (T2): when `false`, the model/endpoint rejects
   * `tool_choice: 'required'` (some OpenRouter routes), so we never
   * force it — we return 'auto' and let the model decide. Defaults to `true`
   * (force as before; the runtime tool_choice floor is the backstop if this
   * guess is wrong).
   */
  modelSupportsForcedToolChoice?: boolean;
}

export type ToolChoice = 'required' | 'auto' | 'none';

/**
 * Compute the tool_choice value for a given runner turn.
 *
 * Rules (from legacy runner.py, turn 934-945):
 *  - Orchestrators: force 'required' on turn 1 only — they often need to
 *    generate a final user-facing message on later turns.
 *  - Worker agents with adapter tools: force 'required' every turn — they
 *    must call tools, and return_result provides the exit path.
 *  - Everyone else: 'auto'.
 *
 * 'none' is kept in the type for future use but never returned here.
 */
export function computeToolChoice(cfg: ToolChoiceConfig): ToolChoice {
  const { isOrchestrator, turn, hasAdapterTools, modelSupportsForcedToolChoice = true } = cfg;

  // Per-model gate: a model that rejects forced tool_choice can never be sent
  // 'required' — fall back to 'auto' (the model decides). This avoids a guaranteed
  // failed call; the runtime floor would otherwise relax it after one wasted try.
  if (!modelSupportsForcedToolChoice) {
    return 'auto';
  }

  // Worker with adapter tools → always required (GPT drift prevention)
  if (hasAdapterTools && !isOrchestrator) {
    return 'required';
  }

  // Orchestrator first turn → required (must call assign_* or create_task)
  if (isOrchestrator && turn === 1) {
    return 'required';
  }

  return 'auto';
}
