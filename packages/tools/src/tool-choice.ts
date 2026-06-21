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
 * Rules:
 *  - Turn 1: force 'required' for orchestrators (must start delegating/planning)
 *    AND for workers with adapter tools (must start using their tools — drift
 *    prevention for models that would otherwise answer in prose without acting).
 *  - After turn 1: 'auto'. The agent decides — crucially this lets it emit a
 *    final FREE-FORM TEXT answer (a research report, a synthesis, a summary).
 *
 * Why NOT force workers every turn (the previous rule): forcing 'required' on
 * every turn makes a text deliverable IMPOSSIBLE — the agent can only ever call
 * a tool, never write its report as a final assistant message. A research agent
 * forced this way gathers data then calls return_result without ever composing
 * the report, so the result is empty. Turn-1 force + auto after preserves
 * drift-prevention while allowing the agent to actually write its answer.
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

  // Turn 1: force tool use so orchestrators start delegating and workers start
  // using their tools. After turn 1, 'auto' so the agent can write a final
  // free-form text answer instead of being trapped into always calling a tool.
  if (turn === 1 && (isOrchestrator || hasAdapterTools)) {
    return 'required';
  }

  return 'auto';
}
