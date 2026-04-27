// router/only-one-per-turn.ts — filter delegation tool calls to first only
// The legacy runner uses `break` after the first assign_* to stop processing.
// We encode that as a pure function for testability.

// ─── ToolCallBlock (minimal shape the runner uses) ────────────────────────────

export interface ToolCallBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ─── filterToolCallsForDelegation ─────────────────────────────────────────────

/**
 * Given a raw list of tool_use blocks from an LLM response, keep only the
 * FIRST assign_* call and drop any subsequent ones.
 *
 * Returns:
 *   - `kept`: the first assign_* block (if any) — this one executes
 *   - `dropped`: all subsequent assign_* blocks — these become deferred
 *                tool_results ("Deferred — another handoff in this turn took priority")
 *   - `others`: non-assign_* blocks (unchanged — processed normally)
 *
 * Only ONE delegation per turn is honored (the legacy `break` pattern).
 * Multiple assign_* in one response = parallel chaos. Safer to defer.
 *
 * Why: LLMs sometimes emit assign_X + assign_Y in one response. Executing both
 * would create two concurrent child jobs, the parent would await both, and the
 * tool_result structure would be broken (only one tool_use_id tracked in
 * pending_delegation). Deferring the second ensures message-structure integrity.
 */
export function filterToolCallsForDelegation(rawCalls: ToolCallBlock[]): {
  kept: ToolCallBlock | null;
  dropped: ToolCallBlock[];
  others: ToolCallBlock[];
} {
  const assignCalls = rawCalls.filter((b) => b.name.startsWith('assign_'));
  const nonAssignCalls = rawCalls.filter((b) => !b.name.startsWith('assign_'));

  if (assignCalls.length === 0) {
    return { kept: null, dropped: [], others: nonAssignCalls };
  }

  const [first, ...rest] = assignCalls;

  return {
    kept: first ?? null,
    dropped: rest,
    others: nonAssignCalls,
  };
}

// ─── buildDeferredToolResults ─────────────────────────────────────────────────

/**
 * Build tool_result entries for dropped assign_* blocks.
 * These are injected into the parent's pending_delegation.sideToolResults
 * so the message-structure invariant (every tool_use has a tool_result) holds.
 */
export function buildDeferredToolResults(
  dropped: ToolCallBlock[],
): Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }> {
  return dropped.map((block) => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content:
      'Deferred — another handoff in this turn took priority. ' +
      'Call me again after the first handoff completes and you have its result.',
    is_error: true,
  }));
}
