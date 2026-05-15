// @nodal-agents/orchestration — core types
// No hardcoded agent slugs, names, or metadata. All data-driven from DB.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { ToolDefinition } from '@nodal-agents/tools';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

export type AgentId = string & { __brand: 'AgentId' };
export type JobId = string & { __brand: 'JobId' };
export type TaskId = string & { __brand: 'TaskId' };
export type EntityId = string & { __brand: 'EntityId' };

// ─── OrchestratorMode ─────────────────────────────────────────────────────────

/**
 * 'router'  — has sub-orchestrators; routes via assign_* tools
 * 'planner' — has worker children only; uses create_task / list_tasks
 * 'worker'  — no children; runs tools directly
 */
export type OrchestratorMode = 'router' | 'planner' | 'worker';

// ─── Agent shape (minimal — what orchestration needs) ─────────────────────────

export interface Agent {
  id: AgentId;
  name: string;
  slug: string;
  role: 'agent' | 'orchestrator' | 'system';
  personality: string;
  entityId: EntityId | null;
  model: string;
  active: boolean;
  orchestratorMode: 'router' | 'planner' | null;
  /** Char budget for memory auto-injection into the system prompt (Sprint 2). */
  memoryTokenBudget: number;
}

// ─── AgentJob shape (minimal) ─────────────────────────────────────────────────

export interface AgentJob {
  id: JobId;
  agentId: AgentId | null;
  entityId: EntityId | null;
  status: string;
  messages: unknown[];
  pendingDelegation: PendingDelegation | null;
  chainCount: number;
  delegationDepth: number;
  parentJobId: JobId | null;
  task: string;
  channel: string;
  chatId: string | null;
}

// ─── DelegationContext ────────────────────────────────────────────────────────

export interface DelegationContext {
  /** The tool_use_id from the LLM response that triggered this delegation */
  toolUseId: string;
  /** Slug of the child agent being delegated to */
  childSlug: string;
  /** The task passed to the child */
  task: string;
  /** Optional chat_id to propagate down the delegation chain */
  chatId: string | null;
  /** Data from prior steps to pass along */
  data?: string;
}

// ─── PendingDelegation (stored in agent_jobs.pending_delegation) ──────────────

export interface PendingDelegation {
  type: 'single';
  toolUseId: string;
  /**
   * Name of the assign_* tool that triggered this delegation (e.g. assign_worker_fr).
   * Required by AI SDK v4 tool-result message format on resume.
   */
  toolName?: string;
  subJobId: JobId;
  /** tool_results for sibling tool_use blocks in the same response (message-integrity) */
  sideToolResults?: SideToolResult[];
}

export interface SideToolResult {
  type: 'tool_result';
  tool_use_id: string;
  /**
   * Name of the dropped tool_use block (e.g. assign_other_agent).
   * Required to rebuild the tool-result in AI SDK v4 format on resume.
   */
  toolName?: string;
  content: string;
  is_error?: boolean;
}

// ─── ToolDefinition (re-export alias for convenience) ─────────────────────────

export type { ToolDefinition, AnyDrizzleDb };

// ─── TaskInput ────────────────────────────────────────────────────────────────

export interface TaskInput {
  task: string;
  chatId?: string | null;
  data?: string;
}

// ─── ChainLimits ──────────────────────────────────────────────────────────────

export interface ChainLimits {
  maxChains: number;
  maxToolCallsPerTurn: number;
  maxDelegationDepth: number;
  maxTurns: number;
}

// ─── ChildAgent (read from DB) ────────────────────────────────────────────────

export interface ChildAgent {
  id: AgentId;
  name: string;
  slug: string;
  role: 'agent' | 'orchestrator' | 'system';
  description: string;
  /** Tool definitions for this child's adapter tools (slugs, not full tools) */
  adapterSlugs?: string[];
}

// ─── DelegationResult ────────────────────────────────────────────────────────

export interface DelegationResult {
  childJobId: JobId;
  parentJobUpdated: AgentJob;
}
