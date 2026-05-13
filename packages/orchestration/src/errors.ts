// @nodal-agents/orchestration — typed error classes
// All errors carry typed codes, no user-facing copy.

// ─── DelegationPendingError ───────────────────────────────────────────────────

/**
 * Thrown by assign_* tool execute() to signal that the parent job must suspend.
 * The runner catches this and transitions the job to awaiting_delegation.
 */
export class DelegationPendingError extends Error {
  readonly code = 'delegation_pending' as const;

  constructor(
    public readonly childJobId: string,
    public readonly childSlug: string,
  ) {
    super(`delegation_pending: delegated to ${childSlug} (job ${childJobId})`);
    this.name = 'DelegationPendingError';
  }
}

// ─── ChainLimitExceededError ──────────────────────────────────────────────────

export class ChainLimitExceededError extends Error {
  readonly code = 'chain_limit_exceeded' as const;

  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`chain_limit_exceeded: ${current} >= ${limit}`);
    this.name = 'ChainLimitExceededError';
  }
}

// ─── ToolCallLimitExceededError ───────────────────────────────────────────────

export class ToolCallLimitExceededError extends Error {
  readonly code = 'tool_call_limit_exceeded' as const;

  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`tool_call_limit_exceeded: ${current} >= ${limit}`);
    this.name = 'ToolCallLimitExceededError';
  }
}

// ─── DelegationDepthExceededError ────────────────────────────────────────────

export class DelegationDepthExceededError extends Error {
  readonly code = 'delegation_depth_exceeded' as const;

  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`delegation_depth_exceeded: ${current} >= ${limit}`);
    this.name = 'DelegationDepthExceededError';
  }
}

// ─── OrchestrationError (generic) ────────────────────────────────────────────

export type OrchestrationErrorCode =
  | 'delegation_pending'
  | 'chain_limit_exceeded'
  | 'tool_call_limit_exceeded'
  | 'delegation_depth_exceeded'
  | 'parent_not_found'
  | 'parent_wrong_status'
  | 'missing_tool_use_id'
  | 'child_agent_not_found'
  | 'cycle_detected'
  | 'missing_dependency'
  | 'task_board_error';

export class OrchestrationError extends Error {
  constructor(
    public readonly code: OrchestrationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'OrchestrationError';
  }
}
