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
   * List of workspaces for this agent, loaded from agent_workspaces rows at
   * job start by the runner (ordered by position ASC). Each entry carries a
   * `label` (the path prefix the LLM uses, e.g. "notes") and the absolute
   * `path` on the filesystem. An empty array means the agent has no workspace
   * configured — every file_* tool call fails loud with `workspace_not_configured`.
   *
   * Addressing:
   *   - Single workspace: label is optional — `file.md` resolves under the sole root.
   *   - Multiple workspaces: `<label>/<relative>` is required (e.g. "notes/file.md").
   */
  workspaces?: Array<{ label: string; path: string }>;
  /**
   * Absolute path to the community-skill store root (e.g. `~/.nodalai/skills`),
   * injected by the runner. Each installed skill's bundled files live under
   * `<skillStoreDir>/<slug>/`. Absent in lightweight contexts → the
   * `skill_file_*` tools fail loud (`skill_store_unavailable`) instead of
   * reading from an unknown location.
   */
  skillStoreDir?: string;
  /**
   * Slugs of the skills assigned to this agent. The `skill_file_*` tools only
   * allow reading the bundle of a skill the agent actually holds — an agent
   * cannot read another skill's files. Loaded by the runner from
   * agent_skill_assignments alongside requiredBuiltins.
   */
  assignedSkillSlugs?: string[];
  /**
   * Infrastructure-provisioning capabilities for ROOT meta-tools that create
   * MCP servers (and, later, connectors). Injected by the runner, which owns
   * the MCP adapter and secret encryption — so packages/tools takes no
   * dependency on either. Absent in lightweight contexts: a meta-tool that
   * needs it fails loud (`provisioning_unavailable`) rather than writing an
   * unverified row.
   */
  provisioning?: ToolProvisioning;
}

// ─── ToolProvisioning ──────────────────────────────────────────────────────────

/**
 * MCP connect options for provisioning verification. Mirrors the MCP adapter's
 * option shape, redeclared here so packages/tools stays free of an adapter
 * dependency — the runner adapts `connectMcp` to this interface.
 */
export type ProvisionMcpConnect =
  | {
      transport: 'http';
      url: string;
      apiKey?: string;
      authScheme?: 'header' | 'query' | 'bearer';
      authParamName?: string;
    }
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> };

/**
 * Capabilities the runner injects so ROOT meta-tools can verify-then-write
 * external infrastructure without packages/tools importing the MCP adapter or
 * the secrets package.
 */
export interface ToolProvisioning {
  /**
   * Connect to an MCP server and list its tools. MUST throw on any
   * connect/auth/spawn failure (fail-loud, no DB write); the caller MUST close
   * the returned connection.
   */
  connectMcp(opts: ProvisionMcpConnect): Promise<{
    tools: Array<{ name: string; description: string | null }>;
    close: () => Promise<void>;
  }>;
  /** Encrypt a secret value for at-rest storage. */
  encrypt(plaintext: string): string;
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
