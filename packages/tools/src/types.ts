// @nodal-agents/tools — core types
// RiskLevel is imported from @nodal-agents/shared (single source of truth)

import type { z } from 'zod';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { EmbeddingClient } from '@nodal-agents/llm';
import type { OperationRiskLevel } from '@nodal-agents/shared';

// RiskLevel is OperationRiskLevel — single source of truth from @nodal-agents/shared
export type RiskLevel = OperationRiskLevel;

// ─── ToolContext ───────────────────────────────────────────────────────────────

/**
 * Runtime context passed to every tool.execute() call.
 * Carries job/agent identity and the DB handle — enough for any built-in tool.
 * Adapter tools may extend this via their own sub-context if needed.
 */
export interface ToolContext {
  jobId: string;
  agentId: string;
  entityId: string;
  db: AnyDrizzleDb;
  /**
   * The chatId that originated this job (set by Telegram inbound handler).
   * null for jobs started from the dashboard, cron, or API.
   * Used by telegram_send_message as the default reply target when the caller
   * does not explicitly provide a chatId argument.
   */
  jobChatId: string | null;
  /**
   * Embedding client for tools that persist or search semantic memory
   * (save_memory generates an embedding at write time). Optional: the runner
   * always provides it, but lightweight test contexts may omit it — memory
   * writes then simply store no embedding and search falls back to keyword.
   */
  embeddingClient?: EmbeddingClient;
  /**
   * Absolute filesystem path the file_* tools are scoped to for this agent.
   * Resolved from `agents.workspace_root_path` at job start by the runner.
   * `null` (the column default) means the agent has no workspace configured;
   * every file_* tool call fails loud with `workspace_not_configured`.
   * Per-agent so a single entity can run multiple agents over distinct scopes
   * (e.g. an Obsidian-vault agent vs a code-repo agent).
   */
  workspaceRootPath?: string | null;
}

// ─── ToolDefinition ────────────────────────────────────────────────────────────

/**
 * A typed, self-describing tool that can be registered and executed.
 *
 * TInput  — Zod schema for the tool's input (validated before execute() is called)
 * TOutput — the resolved return type of execute()
 */
export interface ToolDefinition<TInput extends z.ZodTypeAny, TOutput> {
  name: string;
  description: string;
  inputSchema: TInput;
  riskLevel: OperationRiskLevel;
  execute: (input: z.infer<TInput>, ctx: ToolContext) => Promise<TOutput>;
}

// ─── ToolRegistry ─────────────────────────────────────────────────────────────

export interface ToolListFilter {
  riskLevels?: OperationRiskLevel[];
  names?: string[];
}

export interface ToolRegistry {
  register<TInput extends z.ZodTypeAny, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;

  get(name: string): ToolDefinition<z.ZodTypeAny, unknown> | undefined;

  list(filter?: ToolListFilter): ToolDefinition<z.ZodTypeAny, unknown>[];

  /**
   * Convert registered tools to Vercel AI SDK tool format.
   * RiskLevel is dropped — the AI SDK format has no concept of risk.
   * names filter lets callers expose only a subset.
   */
  toAiSdkTools(filter?: { names?: string[] }): Record<string, AiSdkTool>;
}

// ─── Vercel AI SDK tool shape ─────────────────────────────────────────────────

/**
 * Minimal representation of a Vercel AI SDK tool entry.
 * The `ai` package's CoreTool has `description`, `parameters` (Zod schema), and
 * an optional `execute` function. We expose only the shape we produce here —
 * the runner assembles messages and calls the tool via executeTool(), not via
 * the SDK's built-in execution path.
 */
export interface AiSdkTool {
  description: string;
  inputSchema: z.ZodTypeAny;
}

// ─── ExecuteOptions ────────────────────────────────────────────────────────────

export interface ApprovalGateRequest {
  approvalRequestId: string;
  toolName: string;
  toolInput: unknown;
  jobId: string;
  agentId: string;
  entityId: string;
}

export interface ExecuteOptions {
  /** Approval rules loaded from DB for this agent/entity. Pass [] if not applicable. */
  approvalRules: ApprovalRule[];
  /**
   * Called when a tool requires approval. Caller (runner) is responsible for
   * updating job status and polling. Returns void — execution stops here.
   */
  onApprovalRequired: (req: ApprovalGateRequest) => Promise<void>;
}

// ─── Approval rule shape (mirrors shared ApprovalRule) ────────────────────────

export interface ApprovalRule {
  id: string;
  toolName: string;
  action: 'auto_approve' | 'require_approval' | 'block';
  agentId: string | null;
  entityId: string | null;
}

// ─── ToolExecutionResult ──────────────────────────────────────────────────────

export type ToolExecutionResult =
  | { outcome: 'success'; output: unknown }
  | { outcome: 'error'; error: string }
  | { outcome: 'awaiting_approval'; approvalRequestId: string };

// ─── Constants ────────────────────────────────────────────────────────────────

/** Risk levels in severity order — used for comparisons and display. */
export const RISK_LEVELS: ReadonlyArray<RiskLevel> = ['read', 'write', 'destructive'] as const;
