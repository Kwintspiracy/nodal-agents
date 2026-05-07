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

// ─── OrchestratorMode detection ───────────────────────────────────────────────
export { detectOrchestratorMode } from './orchestrator-mode';

// ─── Router: assign tools ─────────────────────────────────────────────────────
export { generateAssignTools, getChildAgents } from './router/assign-tools';
export type { AssignInput } from './router/assign-tools';

// ─── Router: delegation ───────────────────────────────────────────────────────
export { handleDelegation } from './router/delegate';

// ─── Router: resume ───────────────────────────────────────────────────────────
export { resumeDelegated } from './router/resume';

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
export { buildSystemPrompt } from './system-prompt';
