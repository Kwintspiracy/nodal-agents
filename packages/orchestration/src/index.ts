// @nodalai/orchestration — public API

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
} from './types.js';

// ─── Errors ───────────────────────────────────────────────────────────────────
export {
  DelegationPendingError,
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
  OrchestrationError,
} from './errors.js';
export type { OrchestrationErrorCode } from './errors.js';

// ─── ChainCounters ────────────────────────────────────────────────────────────
export { ChainCounters, DEFAULT_LIMITS } from './chain-counters.js';

// ─── OrchestratorMode detection ───────────────────────────────────────────────
export { detectOrchestratorMode } from './orchestrator-mode.js';

// ─── Router: assign tools ─────────────────────────────────────────────────────
export { generateAssignTools, getChildAgents } from './router/assign-tools.js';
export type { AssignInput } from './router/assign-tools.js';

// ─── Router: delegation ───────────────────────────────────────────────────────
export { handleDelegation } from './router/delegate.js';

// ─── Router: resume ───────────────────────────────────────────────────────────
export { resumeDelegated } from './router/resume.js';

// ─── Router: only-one-per-turn ────────────────────────────────────────────────
export {
  filterToolCallsForDelegation,
  buildDeferredToolResults,
} from './router/only-one-per-turn.js';
export type { ToolCallBlock } from './router/only-one-per-turn.js';

// ─── Planner: task tools ──────────────────────────────────────────────────────
export { generateTaskTools } from './planner/task-tools.js';
export type { CreateTaskInput, ListTasksInput } from './planner/task-tools.js';

// ─── Planner: dependencies ────────────────────────────────────────────────────
export { validateDependencies, checkAllDepsResolved } from './planner/dependencies.js';

// ─── Planner: completion ──────────────────────────────────────────────────────
export { checkRootJobComplete, getPendingTasksForRoot } from './planner/completion.js';

// ─── Team block (auto-generated from DB) ─────────────────────────────────────
export { buildTeamBlock } from './team-block.js';

// ─── System prompt assembly ───────────────────────────────────────────────────
export { buildSystemPrompt } from './system-prompt.js';
