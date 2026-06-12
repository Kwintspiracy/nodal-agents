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
  /**
   * Max number of consecutive turns whose ONLY tool calls are user-facing
   * delivery calls (e.g. telegram_send_message) with no return_result. Past
   * this, the runner treats the agent as monologuing/spamming the user and
   * fails the job loud. See execute.ts (`delivery_spam_guard`).
   */
  maxConsecutiveDeliveryTurns: number;
  /**
   * Hard ceiling on TOTAL tokens (input + output, cumulative across resumes)
   * a single job may burn before the runner fails it loud (`token_budget_exceeded`).
   * Agnostic backstop against runaway loops that stay under the turn cap — e.g.
   * a job replaying a growing context every turn (live incident: an Airtable
   * faux-empty loop burned ~2.4M tokens). Legitimate jobs sit far below this;
   * override per-deployment via env MAX_TOTAL_TOKENS_PER_JOB. See execute.ts.
   */
  maxTotalTokensPerJob: number;
  /**
   * No-progress detector: if the SAME set of tool calls (toolName + input +
   * output, all identical) repeats this many consecutive turns, the job is
   * stuck (re-asking the same question, getting the same answer) and the runner
   * fails it loud (`no_progress_detected`). Set conservatively high so a
   * legitimate poll (which returns identical RUNNING reads then a DIFFERENT
   * terminal read) finishing within a handful of turns never trips it; this is
   * a backstop below maxTurns for genuinely degenerate loops. See execute.ts.
   */
  maxNoProgressRepeats: number;
  /**
   * Guard 1d — no-delivery runaway detector. After this many consecutive
   * gathering turns with no delivery tool call or return_result, inject a
   * forcing control message. Calibrated above the ≈10-turn legit ceiling.
   * Override via env NO_DELIVERY_NUDGE_AT.
   */
  noDeliveryNudgeAt: number;
  /**
   * Guard 1d — same-tool streak. After this many consecutive turns whose
   * tool calls are ALL the same single tool name (with no delivery), inject
   * the forcing control message. Catches scope-creep / empty-resource loops.
   * Override via env SAME_TOOL_STREAK_NUDGE_AT.
   */
  sameToolStreakNudgeAt: number;
  /**
   * Guard 1d — max nudges before failing. Once exhausted AND turnsSinceDelivery
   * passes noDeliveryFailAt, the job fails loud with `no_delivery_runaway`.
   * Override via env MAX_NO_DELIVERY_NUDGES.
   */
  maxNoDeliveryNudges: number;
  /**
   * Guard 1d — minimum turns between consecutive nudges (prevents nudge flooding
   * on a fast model that ignores them). Override via env NO_DELIVERY_NUDGE_SPACING.
   */
  nudgeSpacing: number;
  /**
   * Guard 1d — hard fail threshold. When all nudge budget is spent AND
   * turnsSinceDelivery climbs past this, fail the job loud BEFORE the next
   * LLM call. Override via env NO_DELIVERY_FAIL_AT.
   */
  noDeliveryFailAt: number;
  /**
   * Guard 1e — real dollar cost cap. If the cumulative billed cost for this job
   * (as reported by the provider) exceeds this value, the runner fails the job
   * loud with `cost_budget_exceeded` BEFORE acting on the turn's output.
   *
   * This is a hard backstop for providers that return per-call cost
   * (OpenRouter with `usage:{include:true}`). For providers that don't report
   * cost, this guard never fires — the token budget (Guard 1a) remains the
   * fallback. Override per-deployment via env MAX_COST_PER_JOB_USD.
   *
   * Default 2.0 is a conservative starting point calibrated against known
   * runaway burns ($0.7–1.6 for cheap-model jobs hitting token caps) while
   * allowing legitimate cheap-model jobs (~$0.3) and mid-range jobs well under
   * budget. NOTE: expensive models (GPT-4o, Claude Opus) cost more per job —
   * per-agent caps are the proper follow-up; this is a global backstop.
   */
  maxCostPerJobUsd: number;
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
