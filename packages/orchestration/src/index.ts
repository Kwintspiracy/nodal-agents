// @nodal-agents/orchestration — public API

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  OrchestratorMode,
  Agent,
  AgentJob,
  AgentId,
  JobId,
  TaskId,
  EntityId,
  DelegationContext,
  PendingDelegation,
  SideToolResult,
  TaskInput,
  ChainLimits,
  ChildAgent,
  DelegationResult,
} from './types';

// ─── Errors ───────────────────────────────────────────────────────────────────
export {
  DelegationPendingError,
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
  OrchestrationError,
} from './errors';
export type { OrchestrationErrorCode } from './errors';

// ─── ChainCounters ────────────────────────────────────────────────────────────
export { ChainCounters, DEFAULT_LIMITS } from './chain-counters';

// ─── Guard 1f — non-progress detector (pure reducers) ────────────────────────
export {
  NON_PROGRESS_SAME_TOOL_NUDGE_AT,
  NON_PROGRESS_SAME_TOOL_FAIL_AT,
  NON_PROGRESS_ERROR_STREAK_NUDGE_AT,
  NON_PROGRESS_ERROR_STREAK_FAIL_AT,
  NON_PROGRESS_EXEMPT_TOOLS,
  recordSameToolCall,
  recordToolOutcome,
  INITIAL_SAME_TOOL_STREAK_STATE,
  INITIAL_ERROR_STREAK_STATE,
} from './chain-counters';
export type { SameToolStreakState, ErrorStreakState, NonProgressSignal } from './chain-counters';

// ─── Guard 1g — verify-before-assert nudge (cancel/undo intent) ─────────────
export {
  CANCEL_UNDO_INTENT_RE,
  CANCEL_UNDO_INTENT_SCAN_CHARS,
  VERIFY_BEFORE_ASSERT_NUDGE,
} from './chain-counters';

// ─── OrchestratorMode detection ───────────────────────────────────────────────
export { detectOrchestratorMode } from './orchestrator-mode';

// ─── Router: assign tools ─────────────────────────────────────────────────────
export { generateAssignTools, getChildAgents } from './router/assign-tools';
export type { AssignInput } from './router/assign-tools';

// ─── Router: tool availability (B2 brief validation) ─────────────────────────
export {
  computeAgentToolNames,
  findUnavailableToolMentions,
  KNOWN_TOOL_NAME_UNIVERSE,
} from './router/tool-availability';

// ─── Router: internal (always-on) tool descriptors, for the Autonomy screen ──
export { INTERNAL_TOOL_DESCRIPTORS, UNBLOCKABLE_TOOLS } from './router/internal-tools';
export type { InternalToolDescriptor } from './router/internal-tools';

// ─── Router: delegation ───────────────────────────────────────────────────────
export { handleDelegation } from './router/delegate';

// ─── Router: resume ───────────────────────────────────────────────────────────
export { resumeDelegated } from './router/resume';
export type { DelegationOutcome } from './router/resume';

// ─── Router: only-one-per-turn ────────────────────────────────────────────────
export { filterToolCallsForDelegation, buildDeferredToolResults } from './router/only-one-per-turn';
export type { ToolCallBlock } from './router/only-one-per-turn';

// ─── Planner: task tools ──────────────────────────────────────────────────────
export { generateTaskTools } from './planner/task-tools';
export type { CreateTaskInput, ListTasksInput } from './planner/task-tools';

// ─── Planner: dependencies ────────────────────────────────────────────────────
export { validateDependencies, checkAllDepsResolved } from './planner/dependencies';

// ─── Planner: completion ──────────────────────────────────────────────────────
export { checkRootJobComplete, getPendingTasksForRoot } from './planner/completion';

// ─── Team block (auto-generated from DB) ─────────────────────────────────────
export { buildTeamBlock } from './team-block';

// ─── System prompt assembly ───────────────────────────────────────────────────
export { buildSystemPrompt, buildRuntimeBlock } from './system-prompt';
export type {
  JobContext,
  DeploymentContext,
  CodeProjectSummary,
  ConversationContext,
} from './system-prompt';
