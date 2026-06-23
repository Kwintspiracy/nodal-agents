// job/execute.ts — executeJob: the main LLM loop
// Invariants enforced:
//   2: no hardcoded user-facing strings (error codes only)
//   3: no agent-specific band-aids (fail loud on all errors)
//   4: no silent fallbacks
//   8: anti-loop guards (ChainCounters from @nodal-agents/orchestration)
//   9: tool whitelist explicit per agent (computeToolWhitelist)

import { eq, and, isNull } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  agentTasks,
  approvalRules,
  approvalRequests,
  agentSkillAssignments,
  agentSkills,
  agentConnectorAssignments,
  connectors as connectorsTable,
  mcpServers as mcpServersTable,
  agentMcpServers as agentMcpServersTable,
  agentWorkspaces as agentWorkspacesTable,
  entities as entitiesTable,
  getDecryptedCredentialById,
} from '@nodal-agents/db';
import { enabledMetaTools, parseRootGrants, modelContextWindow } from '@nodal-agents/shared';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { createMcpTools, slugToPrefix, connectMcp } from '@nodal-agents/adapter-mcp';
import {
  QuotaExhaustedError,
  MessageStructureError,
  AllProvidersFailedError,
  validateMessageStructure,
} from '@nodal-agents/llm';
import type { NodalLlmClient } from '@nodal-agents/llm';
import { resolveAgentLlmClient } from './resolve-llm.ts';
import {
  computeToolWhitelist,
  computeToolChoice,
  executeTool,
  ALWAYS_ON_TOOLS,
  createTelegramSendMessageTool,
  createSendImageTool,
  listWorkspaceMcpToolNames,
} from '@nodal-agents/tools';
import type { ToolDefinition, ApprovalRule, ToolProvisioning } from '@nodal-agents/tools';
import {
  ChainCounters,
  DEFAULT_LIMITS,
  generateAssignTools,
  generateTaskTools,
  handleDelegation,
  resumeDelegated,
  filterToolCallsForDelegation,
  buildDeferredToolResults,
  buildSystemPrompt,
  ChainLimitExceededError,
  ToolCallLimitExceededError,
  DelegationDepthExceededError,
  DelegationPendingError,
} from '@nodal-agents/orchestration';
import { decrypt, encrypt } from '@nodal-agents/secrets';
import type { AgentId, JobId, EntityId, Agent, JobContext } from '@nodal-agents/orchestration';
import type { z } from 'zod';
import type { ModelMessage } from 'ai';
import {
  failJob,
  completeJob,
  cancelJob,
  setJobStatus,
  saveCheckpoint,
  touchJob,
  claimJob,
} from './state.ts';
import { loadThreadHistory } from './thread-history.ts';
import { triggerWorker } from '../routes/agent.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { skillStoreDir } from '../skills/index.ts';
import { maybeRunReflection } from '../reflection/index.ts';
import { getDeploymentContext } from './deployment.ts';

// Per-result char budget for tool outputs entering the conversation. A single
// tool (e.g. firecrawl_scrape returning a full web page) can otherwise inject
// 100K+ tokens into `messages`, which every subsequent turn re-sends to the
// LLM — the cost multiplier behind runaway jobs. We truncate to a fixed budget
// with an explicit marker so the model knows content was cut and can re-scrape
// a narrower target. Tunable; 50K chars ≈ ~13K tokens.
const MAX_TOOL_RESULT_CHARS = 50_000;

// Capabilities injected into ROOT meta-tools (create_mcp) via ToolContext.
// Verify-then-write: connectMcp throws on any connect/auth/spawn failure, so the
// meta-tool never persists an unverified server. Adapts the MCP adapter's
// connection shape to ToolProvisioning and exposes secret encryption — keeping
// packages/tools free of adapter/secrets dependencies.
const TOOL_PROVISIONING: ToolProvisioning = {
  async connectMcp(opts) {
    const conn = await connectMcp(opts);
    return {
      tools: conn.tools.map((t) => ({ name: t.name, description: t.description ?? null })),
      close: conn.close,
    };
  },
  encrypt,
};

// User-facing delivery tools: ones that push a message to a human channel.
// A turn whose tool calls are ALL in this set (and contains no return_result)
// is "delivery-only" — used by the anti-spam guard in the main loop to detect
// an agent that keeps messaging the user across consecutive turns instead of
// finishing with return_result. Extend this set as new outbound channels ship
// (whatsapp_send_message, slack_send_message, …).
const DELIVERY_TOOL_NAMES: ReadonlySet<string> = new Set(['telegram_send_message', 'send_image']);

// Guard 1d — delivery tools whose presence in a turn counts as "delivered" for
// the no-delivery runaway detector. Superset of DELIVERY_TOOL_NAMES: also includes
// `dashboard_publish` (the non-Telegram delivery path) and `return_result` itself.
// Any tool call in this set resets turnsSinceDelivery to 0.
const DELIVERY_OR_TERMINAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'return_result',
  'dashboard_publish',
  'telegram_send_message',
  'send_image',
]);

// Channels whose ONLY path to the user is a delivery tool call (telegram_send_message).
// For these, a job that completes without ever delivering is a silent black hole —
// the delivery guard re-prompts the agent before letting such a job finish. Other
// channels (api, dashboard, cron, internal, …) expose agent_jobs.result directly, so
// a text-only completion is fine there. Extend as new tool-only channels ship.
const TOOL_ONLY_DELIVERY_CHANNELS: ReadonlySet<string> = new Set(['telegram']);

/** Truncate an oversized tool-result string with an explicit, model-readable marker. */
export function truncateForContext(value: string): string {
  // Elide long base64/binary runs FIRST. They're useless to the model as text,
  // and they're the dominant re-sent-every-turn bloat: a generated image comes
  // back as ~50K of base64, and the runner re-sends the whole history each turn,
  // so over ~10 turns one job burns ~700K input tokens (observed live, 7c78bf2c,
  // $2.14). Files belong on disk — reference them by path/URL, not inline bytes.
  const v = value.replace(
    /[A-Za-z0-9+/]{256,}={0,2}/g,
    (m) => `[binary elided: ${m.length} chars — reference the file by path/URL, not inline]`,
  );
  if (v.length <= MAX_TOOL_RESULT_CHARS) return v;
  const dropped = v.length - MAX_TOOL_RESULT_CHARS;
  return (
    v.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[... truncated: ${dropped} chars dropped (total ${v.length}) ...]`
  );
}

const EVICTED_TOOL_RESULT_MARKER =
  '[earlier tool result elided to fit the context window — re-run the tool if you need this data again]';

/**
 * Context compaction (Guard 1c). Replaces the OUTPUT of tool-result parts in all
 * but the last `keepRecentToolMessages` tool messages with a short marker. Stale
 * tool output is the dominant consumer of a long job's context (often 70%+); the
 * agent has usually acted on it already, so evicting it shrinks every subsequent
 * prompt — preventing context-window overflow and bounding cost — while keeping
 * the recent turns intact. Structure-safe: toolCallId/toolName are preserved, so
 * tool_use↔tool_result pairing (and message-structure validation) is unaffected.
 * Returns the new array + the number of results evicted (0 ⇒ nothing changed).
 */
export function compactOldToolResults(
  messages: readonly ModelMessage[],
  keepRecentToolMessages: number,
): { messages: ModelMessage[]; evicted: number } {
  const toolMsgIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolMsgIdx.push(i);
  });
  const evictCount = toolMsgIdx.length - keepRecentToolMessages;
  if (evictCount <= 0) return { messages: [...messages], evicted: 0 };
  const evictIdx = new Set(toolMsgIdx.slice(0, evictCount));
  let evicted = 0;
  const out = messages.map((m, i): ModelMessage => {
    if (!evictIdx.has(i) || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    const content = m.content.map((p) => {
      if (p.type !== 'tool-result') return p;
      if (p.output.type === 'text' && p.output.value === EVICTED_TOOL_RESULT_MARKER) return p;
      evicted += 1;
      return { ...p, output: { type: 'text' as const, value: EVICTED_TOOL_RESULT_MARKER } };
    });
    return { ...m, content };
  });
  return { messages: out, evicted };
}

/**
 * Build a diagnosable error string from an LLM/provider exception (B3). The AI
 * SDK's APICallError surfaces only a generic "Provider returned error" in
 * `.message`, but carries the REAL upstream detail (e.g. context_length_exceeded,
 * a model-specific rejection) in `.responseBody` / `.data` / `.statusCode`. We
 * splice those in so a failed job's `error` is actionable instead of opaque.
 */
export function describeLlmError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown_error';
  const e = err as { statusCode?: number; responseBody?: unknown; data?: unknown };
  const body =
    typeof e.responseBody === 'string' && e.responseBody.trim().length > 0 ? e.responseBody : '';
  const dataStr = !body && e.data != null ? JSON.stringify(e.data) : '';
  const detail = body || dataStr;
  if (detail) {
    const status = typeof e.statusCode === 'number' ? `${e.statusCode} ` : '';
    return `${status}${err.message}: ${detail}`.slice(0, 400);
  }
  return err.message.slice(0, 200);
}

// Deterministic JSON: object keys sorted recursively so two semantically-equal
// values serialize identically regardless of key order. Used by the no-progress
// detector (Guard 1b) to compare a turn's tool-call signature across turns.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (val as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return val;
  });
}

// ─── JobStatus type (what we return) ─────────────────────────────────────────

export type ExecuteJobResult =
  | { status: 'completed'; result: string }
  // `result` carries a user-facing explanation when one exists (e.g. a blocked
  // agent's reason). It lets a delegating parent relay WHY a child stopped,
  // not just the machine error code — never leave the user without an
  // explanation. The job row's own result column is filled independently by
  // failJob, so direct (non-delegated) surfaces don't depend on this.
  | { status: 'failed'; error: string; result?: string }
  | { status: 'cancelled' }
  | { status: 'awaiting_approval' }
  | { status: 'awaiting_delegation' }
  | { status: 'awaiting_tasks' }
  | { status: 'already_handled' };

// ─── AnyToolDef ──────────────────────────────────────────────────────────────

type AnyToolDef = ToolDefinition<z.ZodTypeAny, unknown>;

// ─── describeUnavailableTool ──────────────────────────────────────────────────

/**
 * Build the corrective message fed back to a model that called a tool not in
 * its whitelist. Lists the available tools and, when the bad name looks like a
 * truncated/abbreviated form of a real one (the classic "dropped the MCP
 * prefix" slip), surfaces a "did you mean" hint so the model can self-correct.
 * Pure — unit-tested in isolation.
 */
export function describeUnavailableTool(badName: string, available: readonly string[]): string {
  const lower = badName.toLowerCase();
  const suggestions = available.filter((t) => {
    const tl = t.toLowerCase();
    return tl !== lower && (tl.endsWith(lower) || tl.includes(lower));
  });
  const hint = suggestions.length ? ` Did you mean: ${suggestions.slice(0, 3).join(' or ')}?` : '';
  return (
    `The tool "${badName}" is not available to you.${hint} ` +
    `Your available tools are: ${available.join(', ')}. ` +
    `Use one of those EXACT names — do not invent, abbreviate, or drop prefixes from tool names.`
  );
}

// ─── shortBlockReason ─────────────────────────────────────────────────────────

/** Fallback when a blocked agent gave no reason at all. */
export const BLOCK_NO_REASON = 'Blocked — the agent stopped without giving a reason.';

/**
 * Condense a blocked agent's reason into a SHORT one-liner for the job's `error`
 * column — the first sentence, capped — so the UI surfaces a readable "why" at a
 * glance instead of the opaque code 'agent_blocked'. The full reason stays in the
 * job's `result`. Pure — unit-tested.
 */
export function shortBlockReason(reason: string): string {
  const r = reason.trim();
  if (!r) return BLOCK_NO_REASON;
  const firstSentence = r.split(/(?<=[.!?])\s/)[0] ?? r;
  return firstSentence.length > 240 ? firstSentence.slice(0, 239).trimEnd() + '…' : firstSentence;
}

// ─── executeJob ───────────────────────────────────────────────────────────────

/**
 * Main LLM loop. Runs a job from pending/processing to terminal or blocked state.
 */
interface ExecuteJobOpts {
  /**
   * True when this job is being driven IN-STACK by its parent's synchronous
   * delegation (`await executeJob(child, …, { inlineDelegation: true })`). The
   * parent handles the child's result itself on return, so the wrapper must NOT
   * also re-trigger the parent — that would double-resume. A RESUMED child
   * (post-approval, via /api/approve → triggerWorker) runs WITHOUT this flag, so
   * the wrapper climbs back up to the suspended parent.
   */
  inlineDelegation?: boolean;
}

/**
 * Public entry point. Runs the job (runJob), then — for a NON-inline invocation
 * that reached a terminal state — re-triggers a parent suspended in
 * `awaiting_delegation` waiting on this child. This is the nested
 * delegation + approval resume path: a delegated child that suspended for
 * approval, then was resumed via /api/approve → triggerWorker, climbs back to
 * its parent here so the whole chain finishes instead of dying at the parent.
 */
export async function executeJob(
  jobId: JobId,
  deps: RunnerDeps,
  runnerEnv?: RunnerEnv,
  opts?: ExecuteJobOpts,
): Promise<ExecuteJobResult> {
  const result = await runJob(jobId, deps, runnerEnv, opts);
  if (
    !opts?.inlineDelegation &&
    (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled')
  ) {
    await maybeResumeParent(jobId, result, deps, runnerEnv);
  }
  return result;
}

/**
 * If `childJobId` has a parent suspended in `awaiting_delegation` waiting on it,
 * resume that parent with the child's terminal outcome and re-trigger it. Safe to
 * call for any job: it no-ops when there is no parent, or the parent is not
 * awaiting delegation (resumeDelegated itself also guards that status). The
 * parent is flipped to `pending` by resumeDelegated, so even if triggerWorker is
 * unavailable (no runnerEnv) the cron execute-ready tick will pick it up.
 */
async function maybeResumeParent(
  childJobId: JobId,
  outcome: Extract<ExecuteJobResult, { status: 'completed' | 'failed' | 'cancelled' }>,
  deps: RunnerDeps,
  runnerEnv?: RunnerEnv,
): Promise<void> {
  const { db } = deps;
  const [child] = await db
    .select({ parentJobId: agentJobs.parentJobId })
    .from(agentJobs)
    .where(eq(agentJobs.id, childJobId as string))
    .limit(1);
  const parentJobId = child?.parentJobId;
  if (!parentJobId) return;

  const [parent] = await db
    .select({ status: agentJobs.status })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId))
    .limit(1);
  // Only a parent ACTIVELY waiting on this delegation should be resumed. The
  // synchronous in-stack path already handled its child (parent is no longer
  // awaiting_delegation by the time it lands here), so this never double-fires.
  if (parent?.status !== 'awaiting_delegation') return;

  if (outcome.status === 'cancelled') {
    // Cascade: the parent's only outstanding work was this child.
    await db
      .update(agentJobs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(agentJobs.id, parentJobId));
    return;
  }

  const childResult =
    outcome.status === 'completed'
      ? outcome.result
      : { error: outcome.result || outcome.error || 'unknown' };
  // Inject the child's outcome as a tool_result on the parent + flip it to
  // pending (resumeDelegated). Re-verifies awaiting_delegation internally.
  await resumeDelegated(parentJobId as JobId, childJobId, childResult, db);

  if (runnerEnv) {
    // Immediate re-trigger; the parent is now `pending` so the cron tick is the
    // fallback if this is unavailable.
    void triggerWorker(parentJobId, runnerEnv);
  }
}

async function runJob(
  jobId: JobId,
  deps: RunnerDeps,
  runnerEnv?: RunnerEnv,
  opts?: ExecuteJobOpts,
): Promise<ExecuteJobResult> {
  const { db, registry } = deps;
  // llmClient is resolved per-job from the agent's llmKeyId (Brique 24/25).
  // Agents MUST have an llmKeyId — if absent we fail loud (invariant 4).
  // deps.llmClient is kept in RunnerDeps for backward compat with tests but
  // execute.ts no longer reads from it at runtime.
  // Definite assignment: llmClient is set unconditionally in the resolution
  // block below (or the function returns early with a failed status).
  let llmClient!: NodalLlmClient;
  // Per-model capability of the primary key (T2): drives computeToolChoice so we
  // don't force tool_choice:'required' on a model that rejects it.
  let modelSupportsForcedToolChoice = true;

  // Wall-clock timer for total_duration_ms persistence. Captured at function
  // entry so it includes job/agent loading, not just the LLM loop.
  const startedAt = Date.now();

  // Trace logger — minimal, prefixed with jobId for grep. Goes to runner.log
  // via stderr so we can reconstruct what happened to a job after the fact.
  const trace = (event: string, data?: Record<string, unknown>): void => {
    console.error(`[exec ${jobId}] ${event}`, data ? JSON.stringify(data) : '');
  };
  trace('enter');

  // ── 1. Load job ───────────────────────────────────────────────────────────────
  const jobRows = await db
    .select()
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId as string))
    .limit(1);

  const job = jobRows[0];
  if (!job) {
    return { status: 'failed', error: 'job_not_found' };
  }

  // Leg 1 — Atomic claim (pending → processing, WHERE status='pending').
  // Only 'pending' is a valid entry point. All legitimate resume paths
  // (approval, delegation, self-chain) reset to 'pending' before calling
  // executeJob, so this predicate never blocks a real resume. A second
  // concurrent caller or a post-reap duplicate gets false → already_handled.
  const claimed = await claimJob(db, jobId as string);
  if (!claimed) {
    trace('claim_lost', { status: job.status ?? 'unknown' });
    return { status: 'already_handled' };
  }

  // Invariant 8: chain_count is bumped on every resume from awaiting_delegation
  // (and would also be bumped on awaiting_approval resume once that path ships).
  // Cap at maxChains so a runaway orchestrator that delegates forever instead
  // of calling return_result fails loud rather than spinning indefinitely.
  if ((job.chainCount ?? 0) >= DEFAULT_LIMITS.maxChains) {
    await failJob(db, jobId as string, 'chain_limit_exceeded', {
      inputTokens: job.inputTokens ?? 0,
      outputTokens: job.outputTokens ?? 0,
      effectiveInputTokens: job.effectiveInputTokens ?? job.inputTokens ?? 0,
      totalCostUsd: job.totalCostUsd ?? 0,
      turn: job.turn ?? 0,
      totalDurationMs: 0,
    });
    return { status: 'failed', error: 'chain_limit_exceeded' };
  }

  // The job transcript, declared up-front so EVERY failure path (early validation
  // failures AND the in-loop guards / catch) persists it via failJob — a failed
  // job must be diagnosable, not opaque. Section 11 below refines it (thread
  // history, fresh-task seeding); earlier failures persist what's loaded so far.
  let messages: ModelMessage[] = Array.isArray(job.messages)
    ? (job.messages as ModelMessage[])
    : [];

  // Run-stats accumulators — declared before the first failJob call so all
  // failure paths persist tokens / turn / duration. Seeded from the row so
  // resumed jobs don't reset to 0. AI SDK v4 returns
  // `usage: { promptTokens, completionTokens, totalTokens }`.
  let inputTokens = job.inputTokens ?? 0;
  let outputTokens = job.outputTokens ?? 0;
  // Cumulative EFFECTIVE (non-cached) input = Σ(inputTokens − cachedInputTokens).
  // This is what Guard 1a's budget measures (see the main loop). Seeded from the
  // persisted column so the budget stays cumulative across self-chain resumes;
  // falls back to raw input for pre-0034 rows that never recorded it.
  let effectiveInputTokens = job.effectiveInputTokens ?? job.inputTokens ?? 0;
  // Cumulative real dollar cost billed by the provider (Guard 1e). Seeded from
  // the persisted column so resumes add to the running total. Undefined stays
  // undefined (providers that don't report cost never accumulate here).
  let totalCostUsd = job.totalCostUsd ?? 0;
  // Last non-empty upstream provider name reported by OpenRouter
  // (providerMetadata.openrouter.provider). Updated on every call that carries
  // the field; null when the provider has never reported it this run.
  let servedProvider: string | null = job.servedProvider ?? null;
  let turn = job.turn ?? 0;
  let toolsUsed: string[] = Array.isArray(job.toolsUsed) ? (job.toolsUsed as string[]) : [];

  const runStats = (): {
    inputTokens: number;
    outputTokens: number;
    effectiveInputTokens: number;
    totalCostUsd: number;
    servedProvider: string | null;
    turn: number;
    totalDurationMs: number;
  } => ({
    inputTokens,
    outputTokens,
    effectiveInputTokens,
    totalCostUsd,
    servedProvider,
    turn,
    totalDurationMs: Date.now() - startedAt,
  });

  // ── 3. Load agent ─────────────────────────────────────────────────────────────
  // (Leg 1: status was atomically set to 'processing' by claimJob above.)
  if (!job.agentId) {
    await failJob(db, jobId as string, 'agent_not_found', runStats(), messages);
    return { status: 'failed', error: 'agent_not_found' };
  }

  const agentRows = await db.select().from(agents).where(eq(agents.id, job.agentId)).limit(1);

  const agentRow = agentRows[0];
  if (!agentRow || !agentRow.active) {
    await failJob(db, jobId as string, 'agent_not_found', runStats(), messages);
    return { status: 'failed', error: 'agent_not_found' };
  }

  const agent: Agent = {
    id: agentRow.id as AgentId,
    name: agentRow.name,
    slug: agentRow.slug,
    role: (agentRow.role ?? 'agent') as Agent['role'],
    personality: agentRow.personality,
    entityId: (agentRow.entityId ?? null) as EntityId | null,
    model: agentRow.model ?? 'claude-sonnet-4-6-20260217',
    active: agentRow.active ?? true,
    orchestratorMode: (agentRow.orchestratorMode ?? null) as 'router' | 'planner' | null,
    memoryTokenBudget: agentRow.memoryTokenBudget,
  };

  // ── 3.5 Load agent workspaces ─────────────────────────────────────────────────
  // Ordered by position so the LLM sees workspaces in the user-configured order.
  const wsRows = await db
    .select({ label: agentWorkspacesTable.label, path: agentWorkspacesTable.path })
    .from(agentWorkspacesTable)
    .where(eq(agentWorkspacesTable.agentId, agentRow.id))
    .orderBy(agentWorkspacesTable.position, agentWorkspacesTable.label);
  const agentWorkspacesList: Array<{ label: string; path: string }> = wsRows;

  // Entity-wide SHARED workspace: a common scratch/hand-off area every agent in
  // this entity can read/write — for ARTIFACTS (reports, images, html, pptx) that
  // siblings or later runs need. Auto-created (works out-of-box); complements the
  // per-agent workspaces above (special tasks) and entity-wide memory (facts).
  // Labeled 'shared'. The agent's file_* tools see it like any other workspace.
  if (job.entityId) {
    const sharedPath = join(homedir(), '.nodalai', 'workspaces', job.entityId, 'shared');
    try {
      mkdirSync(sharedPath, { recursive: true });
      if (!agentWorkspacesList.some((w) => w.label === 'shared')) {
        agentWorkspacesList.push({ label: 'shared', path: sharedPath });
      }
    } catch {
      // best-effort — a workspace we couldn't create is simply not offered
    }
  }

  // ── 3.6 Skill-file access context ─────────────────────────────────────────
  // Slugs of skills assigned to this agent + the store root, so the
  // skill_file_* builtins can read an installed (community) skill's bundled
  // files — and only the bundles of skills this agent actually holds.
  const assignedSkillRows = await db
    .select({
      slug: agentSkills.slug,
      scriptsAuthorized: agentSkillAssignments.scriptsAuthorized,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
    .where(eq(agentSkillAssignments.agentId, agentRow.id));
  const assignedSkillSlugs: string[] = assignedSkillRows.map((r) => r.slug);
  // Slugs whose bundled scripts the owner has authorized THIS agent to run via
  // run_skill_script (subset of assignedSkillSlugs). Gates both the tool's
  // availability (whitelist below) and its execution (ToolContext → builtin).
  const scriptAuthorizedSkillSlugs: string[] = assignedSkillRows
    .filter((r) => r.scriptsAuthorized)
    .map((r) => r.slug);
  const skillStore = skillStoreDir(job.entityId);

  // ── Per-agent LLM client resolution (Brique 24/25) ───────────────────────
  // Agents MUST have an llmKeyId pointing at an active entity_llm_keys row.
  // No env-based fallback — fail loud (invariant 4).
  // The agent's `model` column wins over the key's defaultModel (the key's
  // defaultModel is just a UI suggestion).
  if (!agentRow.llmKeyId) {
    await failJob(db, jobId as string, 'agent_no_llm_configured', runStats(), messages);
    return { status: 'failed', error: 'agent_no_llm_configured' };
  }

  {
    // Resolve the agent's LLM client + failover chain (Guard 2). Shared with the
    // chat path via resolveAgentLlmClient so the chain logic can't drift.
    const resolved = await resolveAgentLlmClient(
      db,
      {
        llmKeyId: agentRow.llmKeyId,
        fallbackChain: agentRow.fallbackChain ?? null,
        model: agent.model,
      },
      (info) => trace('fallback_key_skipped', info),
    );
    if (!resolved.ok) {
      const code =
        resolved.reason === 'agent_no_llm_configured'
          ? 'agent_no_llm_configured'
          : `llm_key_invalid:${resolved.detail}`;
      await failJob(db, jobId as string, code, runStats(), messages);
      return { status: 'failed', error: code };
    }
    llmClient = resolved.client;
    modelSupportsForcedToolChoice = resolved.primarySupportsForcedToolChoice;
    trace('llm_client_from_key', {
      provider: resolved.primaryProvider,
      chainLength: resolved.chainLength,
      forcedToolChoice: modelSupportsForcedToolChoice,
    });
  }

  // ── 4. Orchestrator? ──────────────────────────────────────────────────────────
  // A unified orchestrator receives BOTH delegation toolsets (assign_* + create_task)
  // and picks the style per request — so the runner no longer pre-detects a single
  // router/planner mode here. The child list and mode detection live in the team
  // block (orchestration/team-block.ts), which builds the prompt guidance from DB.
  const isOrchestrator = agent.role === 'orchestrator';

  // ── 5. Build system prompt ────────────────────────────────────────────────────
  // Build jobContext from job columns — the runner exposes data, the agent
  // personality decides what to do with it (invariant #1: data-driven behavior).
  // `agent_jobs.chat_id` carries the explicit Telegram-delivery intent: each
  // job-creation source (poller, sendTaskAction, cron tick) is responsible for
  // populating it when delivery is wanted. The runner does NOT fall back to
  // the agent's last-seen chat at execute time — that would override the
  // explicit "no Telegram" intent expressed by a NULL chat_id (e.g. dashboard
  // checkbox unticked).
  // A cron job that carries a chatId opted into a success confirmation (the cron
  // tick only sets chat_id when the schedule's notify_on_success is on). Surface
  // that intent to the agent so it ends with a confirmation, and engage the
  // delivery guard below so the send is actually enforced.
  const cronWantsConfirmation = job.channel === 'cron' && job.chatId != null;
  const deployment = await getDeploymentContext(db, job.entityId ?? undefined);
  const jobContext: JobContext = {
    origin: job.channel ?? 'unknown',
    ...(job.chatId ? { telegramChatId: job.chatId } : {}),
    ...(cronWantsConfirmation ? { notifyOnSuccess: true } : {}),
    ...(job.parentJobId ? { isDelegated: true } : {}),
    deployment,
  };

  let systemPrompt = job.systemPrompt;
  if (!systemPrompt) {
    systemPrompt = await buildSystemPrompt(agent, db, jobContext);
    await db
      .update(agentJobs)
      .set({ systemPrompt, updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId as string));
  }

  // ── 6. Build tool set ─────────────────────────────────────────────────────────
  let toolDefs: AnyToolDef[];

  // Always-on built-ins (excluding return_result, which is handled per-branch
  // because orchestrators add it after their orchestration tools and workers
  // pull it via computeToolWhitelist's alwaysOn). The system prompt advertises
  // these to every agent — they MUST be in the runtime toolset too, otherwise
  // the LLM sees them in its prompt and trips AI_NoSuchToolError.
  const memoryBuiltins = ALWAYS_ON_TOOLS.filter((n) => n !== 'return_result')
    .map((n) => registry.get(n))
    .filter((t): t is AnyToolDef => t !== undefined);

  // run_skill_script — offered ONLY to agents with ≥1 owner-authorized
  // script-skill (agent_skill_assignments.scripts_authorized). Gated here at the
  // whitelist (availability) AND in the builtin via scriptAuthorizedSkillSlugs
  // (execution). Name for the worker whitelist, def for the orchestrator branch.
  const scriptToolNames: string[] =
    scriptAuthorizedSkillSlugs.length > 0 ? ['run_skill_script'] : [];
  const scriptToolDefs: AnyToolDef[] = scriptToolNames
    .map((n) => registry.get(n))
    .filter((t): t is AnyToolDef => t !== undefined);

  // Capability tools: computed from agent's configured integrations.
  // These are instantiated per-job and merged directly into toolDefs/toolMap.
  // CRITICAL: do NOT register into the shared registry — the registry is
  // process-scoped and shared across all concurrent jobs. Mutating it here
  // would leak the tool's availability to other agents that share the same
  // RunnerDeps instance, breaking invariant #9 (whitelist explicit per agent).
  // capabilityTools bypasses computeToolWhitelist's registry-based drift check
  // because the definition itself is passed, not just its name.
  const capabilityTools: AnyToolDef[] = [];
  // telegram_send_message is only offered when this job actually has a Telegram
  // recipient to reach: a telegram job, a cron-notify opt-in, or a dashboard task
  // sent "via Telegram" — all carry job.chatId. On a dashboard/api/internal job
  // with no chatId there IS no chat, so offering it just lets the agent try →
  // telegram_no_recipient → the no-false-success guard (Guard 3b) blocks the
  // completion: a successful task wrongly reported as failed/blocked (live: jobs
  // 2ddb15e3, 920fd89c — agent emailed fine, then tried a phantom Telegram
  // confirmation). The user is on the dashboard; dashboard_publish is the path.
  // Gate delivery tools on a resolvable recipient — channel-agnostic, the pattern
  // every future outbound tool (whatsapp/slack) follows.
  if (agentRow.telegramBotToken && job.chatId) {
    capabilityTools.push(createTelegramSendMessageTool() as unknown as AnyToolDef);
    capabilityTools.push(createSendImageTool() as unknown as AnyToolDef);
  }

  // Close callbacks for per-job MCP transports — invoked in the LLM loop's
  // finally so the Streamable HTTP connections never leak.
  const mcpClosers: Array<() => Promise<void>> = [];

  try {
    // ── Root-agent meta-tool gating (applies to BOTH branches) ────────────────
    // The ROOT is always an orchestrator, so this MUST be computed before the
    // orchestrator/worker split — otherwise the ROOT (orchestrator branch) would
    // never receive its meta-tools. Approval-gate (autonomy level) is handled by
    // the existing approval_rules mechanism in executeTool; here we only make the
    // tools AVAILABLE to the designated ROOT, per its enabled grants.
    const [rootEntityRow] = await db
      .select({
        rootAgentId: entitiesTable.rootAgentId,
        rootGrants: entitiesTable.rootGrants,
      })
      .from(entitiesTable)
      .where(eq(entitiesTable.id, job.entityId ?? ''))
      .limit(1);
    const isRootAgent =
      rootEntityRow?.rootAgentId != null && rootEntityRow.rootAgentId === agentRow.id;
    const metaToolNames: string[] = isRootAgent
      ? enabledMetaTools(parseRootGrants(rootEntityRow?.rootGrants)).filter(
          (name) => registry.get(name) !== undefined,
        )
      : [];
    const metaToolDefs: AnyToolDef[] = metaToolNames
      .map((name) => registry.get(name))
      .filter((t): t is AnyToolDef => t !== undefined);

    if (isOrchestrator) {
      // Unified orchestrator: expose BOTH delegation styles and let the model
      // pick per request. assign_* (router) for a SINGLE or reactive/dependent
      // delegation where it needs a result before deciding the next step;
      // create_task (planner) for INDEPENDENT parallel fan-out (the task board
      // runs them concurrently and compiles). A job commits to its first style
      // — once it has created tasks, the assign_ block below defers, so the two
      // completion models never run on the same job. `orchestratorMode` is now a
      // soft preference surfaced in the prompt, not a hard XOR on the toolset.
      const assignTools = (await generateAssignTools(agent.id, db)) as unknown as AnyToolDef[];
      const [createTaskTool, listTasksTool] = generateTaskTools(agent.id, db);
      const returnResult = registry.get('return_result');
      toolDefs = [
        ...assignTools,
        createTaskTool as unknown as AnyToolDef,
        listTasksTool as unknown as AnyToolDef,
        ...memoryBuiltins,
        ...(returnResult ? [returnResult] : []),
        ...metaToolDefs,
        ...scriptToolDefs,
        ...capabilityTools,
      ];
    } else {
      // Worker: whitelist from skill assignments + always-on tools + capability tools
      // Join to agent_skills to retrieve requiredBuiltins for each assigned skill.
      // requiredBuiltins are unioned into the alwaysOn list so that office tools
      // (and any future gated builtins) are unlocked only for agents holding the
      // relevant skill — not globally. This is the gating mechanism for invariant #9.
      const skillRows = await db
        .select({
          skillId: agentSkillAssignments.skillId,
          requiredBuiltins: agentSkills.requiredBuiltins,
        })
        .from(agentSkillAssignments)
        .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
        .where(eq(agentSkillAssignments.agentId, agentRow.id));

      // Collect all requiredBuiltins from assigned skills (deduplicated).
      const skillRequiredBuiltins: string[] = Array.from(
        new Set(skillRows.flatMap((r) => r.requiredBuiltins ?? [])),
      );

      // For workers without adapter registrations, only always-on tools are available.
      // Adapters will be registered in the registry when adapter packages are loaded.
      const configuredToolNames = skillRows
        .map((r) => r.skillId)
        .filter((name): name is string => name !== null);

      // Filter configured tools to only those that exist in the registry
      // (avoids WhitelistDriftError for unregistered adapter tools)
      const registeredConfigured = configuredToolNames.filter(
        (name) => registry.get(name) !== undefined,
      );

      // ── Connector adapter tools ──────────────────────────────────────────────
      // Fetch agent's connector assignments (with per-operation whitelist).
      // Each assignment instantiates its adapter's tools using a bearer token
      // resolved from either:
      //   - connectors.credentialId → credentials.payload.accessToken (OAuth)
      //   - connectors.api_key      → decrypted api_key column (PAT / api_key)
      // null enabledOperations → all tools; array → whitelist on tool.name.
      // Adapters without a registry entry are skipped silently.
      const connectorAssignments = await db
        .select({
          connectorId: connectorsTable.id,
          slug: connectorsTable.slug,
          credentialId: connectorsTable.credentialId,
          apiKey: connectorsTable.apiKey,
          enabledOperations: agentConnectorAssignments.enabledOperations,
        })
        .from(agentConnectorAssignments)
        .innerJoin(connectorsTable, eq(connectorsTable.id, agentConnectorAssignments.connectorId))
        .where(eq(agentConnectorAssignments.agentId, agentRow.id));

      for (const ca of connectorAssignments) {
        const entry = ADAPTER_REGISTRY[ca.slug];
        if (!entry) continue; // no adapter for this catalog slug — skip silently

        let accessToken: string | null = null;
        if (entry.credentialType === 'api_key') {
          // PAT / api_key path: decrypt connectors.api_key directly.
          if (!ca.apiKey) continue;
          try {
            accessToken = decrypt(ca.apiKey);
          } catch {
            continue; // tampered / wrong master key — skip this connector silently
          }
        } else {
          // OAuth path: token lives in credentials.payload.accessToken.
          if (!ca.credentialId) continue;
          const decrypted = await getDecryptedCredentialById(db, ca.credentialId);
          if (!decrypted) continue;
          accessToken = decrypted.payload.accessToken;
        }

        if (!accessToken) continue;

        const allTools = entry.toolFactory(accessToken);
        const enabled = ca.enabledOperations;
        const filtered =
          enabled === null ? allTools : allTools.filter((t) => enabled.includes(t.name));

        capabilityTools.push(...filtered);
      }
      // ────────────────────────────────────────────────────────────────────────

      // ── MCP server tools ─────────────────────────────────────────────────────
      // Each assigned MCP server is connected per-job. Two transports:
      //   - 'http' : Streamable HTTP (Stripe, Cogni, Composio, custom-HTTP)
      //   - 'stdio': local subprocess (filesystem, sqlite, github, custom-stdio)
      // Tools discovered via tools/list and wrapped as ToolDefinitions. A
      // connect failure for one server is swallowed — a broken MCP server must
      // never fail an unrelated job. Transports are closed in the loop finally
      // (closing a stdio transport also terminates the spawned subprocess).
      // null enabledTools → all tools; array → whitelist on the original
      // (un-prefixed) tool name.
      const mcpAssignments = await db
        .select({
          slug: mcpServersTable.slug,
          transport: mcpServersTable.transport,
          url: mcpServersTable.url,
          apiKey: mcpServersTable.apiKey,
          authScheme: mcpServersTable.authScheme,
          authParamName: mcpServersTable.authParamName,
          command: mcpServersTable.command,
          args: mcpServersTable.args,
          envVars: mcpServersTable.envVars,
          enabledTools: agentMcpServersTable.enabledTools,
        })
        .from(agentMcpServersTable)
        .innerJoin(mcpServersTable, eq(mcpServersTable.id, agentMcpServersTable.mcpServerId))
        .where(eq(agentMcpServersTable.agentId, agentRow.id));

      for (const ms of mcpAssignments) {
        try {
          let toolset: Awaited<ReturnType<typeof createMcpTools>>;
          if (ms.transport === 'stdio') {
            // stdio: command + args + env vars (each value encrypted).
            if (!ms.command) continue; // bad row, skip silently
            const rawEnv = (ms.envVars ?? {}) as Record<string, string>;
            let decryptedEnv: Record<string, string>;
            try {
              decryptedEnv = Object.fromEntries(
                Object.entries(rawEnv).map(([k, v]) => [k, decrypt(v)]),
              );
            } catch {
              continue; // tampered env var — skip silently
            }
            toolset = await createMcpTools({
              transport: 'stdio',
              slug: ms.slug,
              command: ms.command,
              args: (ms.args ?? []) as string[],
              env: decryptedEnv,
            });
          } else {
            // http: URL + apiKey + auth metadata, all of which must be set.
            if (!ms.url || !ms.apiKey || !ms.authScheme || !ms.authParamName) continue;
            let decryptedKey: string;
            try {
              decryptedKey = decrypt(ms.apiKey);
            } catch {
              continue; // tampered key — skip silently
            }
            toolset = await createMcpTools({
              transport: 'http',
              slug: ms.slug,
              url: ms.url,
              apiKey: decryptedKey,
              authScheme: ms.authScheme as 'header' | 'query' | 'bearer',
              authParamName: ms.authParamName,
            });
          }
          mcpClosers.push(toolset.close);
          const enabled = ms.enabledTools as string[] | null;
          // Wrapped tool names are `${prefix}__${original}`; the whitelist
          // stores original names → strip the prefix before comparing.
          const prefixLen = slugToPrefix(ms.slug).length + 2;
          const filtered =
            enabled === null
              ? toolset.tools
              : toolset.tools.filter((t) => enabled.includes(t.name.slice(prefixLen)));
          capabilityTools.push(...filtered);
        } catch {
          continue; // MCP server unreachable / auth failed / spawn failed — skip silently
        }
      }
      // ────────────────────────────────────────────────────────────────────────

      // skillRequiredBuiltins: union of requiredBuiltins from all assigned skills.
      // Only add builtins that actually exist in the registry to avoid WhitelistDriftError
      // if a skill references a tool name that hasn't been registered yet.
      const registeredSkillBuiltins = skillRequiredBuiltins.filter(
        (name) => registry.get(name) !== undefined,
      );

      toolDefs = computeToolWhitelist(
        {
          agentId: agentRow.id,
          configuredTools: registeredConfigured,
          alwaysOn: [
            ...ALWAYS_ON_TOOLS,
            ...registeredSkillBuiltins,
            ...metaToolNames,
            ...scriptToolNames,
          ],
        },
        registry,
        capabilityTools,
      );
    }
  } catch (err) {
    const errorCode = err instanceof Error ? err.message : 'whitelist_computation_failed';
    await failJob(db, jobId as string, errorCode, runStats(), messages);
    return { status: 'failed', error: errorCode };
  }

  // ── 8. Load approval rules ────────────────────────────────────────────────────
  const ruleRows = await db
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.entityId, job.entityId ?? ''));

  let approvalRuleList: ApprovalRule[] = ruleRows.map((r) => ({
    id: r.id,
    toolName: r.toolName,
    action: (r.action ?? 'auto_approve') as ApprovalRule['action'],
    agentId: r.agentId,
    entityId: r.entityId,
  }));

  // ── 8b. Workspace Yolo master-switch for run_command ──────────────────────────
  // run_command is RCE-by-design; auto-approving it in a non-local-trust (LAN /
  // multi-user) install is gated behind an explicit, owner-controlled workspace
  // opt-in (entities.lan_command_yolo). The web layer gates *creating* a per-agent
  // auto_approve rule, but rule creation is NOT the security boundary — EXECUTION
  // is. So we enforce the same gate here, authoritatively: when the workspace has
  // not opted in, run_command can never auto-approve, no matter what rules exist.
  //   (a) drop any run_command auto_approve rule, and
  //   (b) if no run_command-specific rule then remains, inject a require_approval
  //       rule so a blanket wildcard ('*') auto_approve can't sweep it in either.
  // Nothing is deleted from the DB — re-enabling the workspace switch reactivates
  // the rules. In local-trust mode (single-user loopback) the switch is N/A.
  //
  // AUTH_MODE source: the passed runnerEnv when present (worker/chat routes +
  // tests), else process.env directly (cron paths call executeJob without it).
  // We read process.env rather than the module `env` proxy ON PURPOSE: the proxy
  // validates the ENTIRE runner env (DATABASE_URL et al.) on first access, which
  // throws in test contexts that don't set it — the cron paths call executeJob
  // without runnerEnv, so that fallback threw and broke cron job execution under
  // test. A single enum needs no full-env validation; default to local-trust.
  const authMode = runnerEnv?.AUTH_MODE ?? process.env['AUTH_MODE'] ?? 'local-trust';
  if (authMode !== 'local-trust') {
    const RUN_COMMAND_TOOL = 'run_command';
    const [yoloEntityRow] = await db
      .select({ lanCommandYolo: entitiesTable.lanCommandYolo })
      .from(entitiesTable)
      .where(eq(entitiesTable.id, job.entityId ?? ''))
      .limit(1);
    if (!yoloEntityRow?.lanCommandYolo) {
      approvalRuleList = approvalRuleList.filter(
        (r) => !(r.toolName === RUN_COMMAND_TOOL && r.action === 'auto_approve'),
      );
      const hasRunCommandRule = approvalRuleList.some((r) => r.toolName === RUN_COMMAND_TOOL);
      if (!hasRunCommandRule) {
        approvalRuleList.push({
          id: 'lan-yolo-gate',
          toolName: RUN_COMMAND_TOOL,
          action: 'require_approval',
          agentId: agentRow.id,
          entityId: job.entityId ?? '',
        });
      }
    }
  }

  // ── 8c. Fully-autonomous workspace ────────────────────────────────────────────
  // The owner's ROOT autonomy level governs how much hand-holding the workspace
  // wants. `fully_autonomous` = "no approval prompts, period" — so we relax the
  // safe-by-default require_approval posture inside executeTool. It is applied
  // there AFTER explicit rules + the run_command LAN master-switch (8b) and BEFORE
  // the catastrophic-command hardline floor, so neither safety boundary is bypassed.
  const [autonomyRow] = await db
    .select({ rootGrants: entitiesTable.rootGrants })
    .from(entitiesTable)
    .where(eq(entitiesTable.id, job.entityId ?? ''))
    .limit(1);
  const workspaceAutonomy = parseRootGrants(autonomyRow?.rootGrants).autonomy;

  // ── 9. Initialize ChainCounters ───────────────────────────────────────────────
  const counters = new ChainCounters(DEFAULT_LIMITS);
  const hasAdapterTools = !isOrchestrator && toolDefs.length > ALWAYS_ON_TOOLS.length;

  // ── 10. Build tool map ────────────────────────────────────────────────────────
  const toolMap = new Map<string, AnyToolDef>(toolDefs.map((t) => [t.name, t]));

  // Skill-authoring grounding (Phase 2): when this agent can create/update skills
  // (it's the ROOT with the grant — the meta-tool is in its map), append the
  // workspace's REAL MCP tool names to those tools' descriptions, so the agent
  // sees the correct `<slug>__<tool>` names BEFORE it writes a skill — instead of
  // falling back on its training prior (`mcp__…`, Claude-in-Chrome). Computed once
  // here (not per turn) since the workspace tool set is fixed for the job.
  let authoringToolsSuffix = '';
  if (toolMap.has('create_skill') || toolMap.has('update_skill')) {
    const mcpToolNames = await listWorkspaceMcpToolNames(db, job.entityId ?? '');
    authoringToolsSuffix =
      mcpToolNames.length > 0
        ? ` When a skill needs an MCP tool, reference one of these EXACT names available in this workspace (built-in and connector tools are bare snake_case and need no namespace): ${mcpToolNames.join(', ')}.`
        : ' This workspace has no MCP servers connected yet — a skill should only reference built-in tools (bare snake_case) or none.';
  }

  // ── 11. Restore conversation ──────────────────────────────────────────────────
  // (`messages` is declared up-front near the top so every failure path persists it.)
  if (messages.length === 0) {
    messages = [{ role: 'user', content: job.task }];
  }

  // ── 11.5 Prepend thread history (session memory for chat channels) ────────────
  // Solves "agent forgets what it just said 30 seconds ago" on Telegram and
  // other conversational channels: load the last few completed exchanges in
  // the same (channel, chat_id) thread and prepend them as ModelMessages so
  // the LLM has continuity.
  //
  // A job is considered "fresh execution" when only the initial user message
  // is in the array — this covers both the Telegram-poller path (which seeds
  // `messages = [{ role: 'user', content: task }]` at insert time, see
  // `apps/runner/src/telegram/handler.ts`) and the dashboard `api` path
  // (which leaves `messages` empty, then the block above seeds it). Resumed
  // jobs (from `awaiting_delegation` / `awaiting_approval`) carry at least
  // one assistant turn already and MUST NOT have history prepended a second
  // time — otherwise we'd duplicate context on every resume.
  //
  // Fail-soft: a DB hiccup logs and continues without history rather than
  // killing the job.
  const isFreshExecution = messages.length === 1 && messages[0]?.role === 'user';
  if (isFreshExecution && job.entityId && job.agentId && job.chatId) {
    try {
      const history = await loadThreadHistory({
        db,
        entityId: job.entityId,
        agentId: job.agentId,
        channel: job.channel,
        chatId: job.chatId,
        excludeJobId: jobId as string,
      });
      if (history.length > 0) {
        trace('thread_history_loaded', { messages: history.length });
        messages = [...history, ...messages];
      }
    } catch (err) {
      trace('thread_history_failed', {
        errMsg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 11.6 ToolResultOutput type + coerce helper (shared by resume step + loop) ──
  // AI SDK v6 ToolResultPart.output is a discriminated union; we coerce all raw
  // tool outputs here so every writer uses the same canonical shape.
  type ToolResultOutput = { type: 'text'; value: string } | { type: 'json'; value: unknown };
  const toResultOutput = (raw: unknown): ToolResultOutput => {
    if (typeof raw === 'string') return { type: 'text', value: truncateForContext(raw) };
    const json: unknown = JSON.parse(JSON.stringify(raw ?? null));
    const serialized = JSON.stringify(json);
    if (serialized.length <= MAX_TOOL_RESULT_CHARS) return { type: 'json', value: json };
    return { type: 'text', value: truncateForContext(serialized) };
  };

  // ── 11.7 Execute-on-resume (Bugs B+C fix) ────────────────────────────────────
  // When the job is resuming after an approval decision, the approved/rejected
  // tool has NOT yet been executed. We do it here — before entering the LLM
  // loop — and replace the [AWAITING_APPROVAL] marker in the saved messages
  // with the real tool output. This guarantees the LLM sees a valid, complete
  // conversation on its next turn without re-issuing the approved call.
  //
  // Gate: only runs when there are resolved-but-not-yet-executed requests.
  // Idempotent: executed_at IS NULL guards against double-execution.
  {
    const pendingExecRows = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, jobId as string), isNull(approvalRequests.executedAt)))
      .orderBy(approvalRequests.requestedAt);

    // Filter to resolved (approved or rejected) rows; anything still 'pending'
    // means the human hasn't acted yet — we'll handle those at suspend time.
    const resolvedRows = pendingExecRows.filter(
      (r) => r.status === 'approved' || r.status === 'rejected',
    );

    if (resolvedRows.length > 0) {
      // Process each resolved request and replace its marker in messages.
      for (const req of resolvedRows) {
        let replacementOutput: ToolResultOutput;

        if (req.status === 'approved') {
          // Execute the approved tool, bypassing the gate — the human already
          // reviewed and approved this exact call. The bypass is expressed via a
          // synthetic auto_approve rule below (NOT an empty rules array: that would
          // re-fire the tool's own defaultApproval and loop forever for run_command).
          const toolDef = toolMap.get(req.toolName);
          if (!toolDef) {
            // Tool no longer in whitelist — treat as error and mark executed.
            replacementOutput = toResultOutput({
              error: `approved_tool_not_found:${req.toolName}`,
            });
          } else {
            // Synthesize an explicit auto_approve rule for this tool so that
            // tools with defaultApproval:'require_approval' (e.g. run_command)
            // bypass their own gate during the resume-execution step. The human
            // already reviewed and approved this exact call — re-gating on the
            // tool's default posture would produce an infinite approval loop.
            const resumeApprovalRules: ApprovalRule[] = [
              {
                id: 'resume-bypass',
                entityId: job.entityId ?? '',
                agentId: null,
                toolName: req.toolName,
                action: 'auto_approve',
              },
            ];
            const execResult = await executeTool(
              toolDef,
              req.toolInput,
              {
                jobId: jobId as string,
                agentId: agentRow.id,
                entityId: job.entityId ?? '',
                db,
                jobChatId: job.chatId ?? null,
                embeddingClient: deps.embeddingClient,
                workspaces: agentWorkspacesList,
                skillStoreDir: skillStore,
                assignedSkillSlugs,
                scriptAuthorizedSkillSlugs,
                provisioning: TOOL_PROVISIONING,
              },
              {
                approvalRules: resumeApprovalRules,
                autonomy: workspaceAutonomy,
                onApprovalRequired: async () => {},
              },
            );
            if (execResult.outcome === 'success') {
              replacementOutput = toResultOutput(execResult.output);
            } else if (execResult.outcome === 'error') {
              replacementOutput = toResultOutput({ error: execResult.error });
            } else {
              // outcome === 'awaiting_approval' should never occur — we passed a
              // synthetic auto_approve rule that overrides any defaultApproval.
              replacementOutput = toResultOutput({ error: 'unexpected_gate_on_approved_tool' });
            }
          }
          trace('resume_approved_tool_executed', { toolName: req.toolName });
        } else {
          // Rejected: replace marker with a [REJECTED] explanation.
          const reason = req.notes ?? 'no reason provided';
          replacementOutput = toResultOutput(
            `[REJECTED] Human reviewer rejected this action. Reason: ${reason}. Adapt your approach.`,
          );
          trace('resume_rejected_tool_marker_replaced', { toolName: req.toolName });
        }

        // Find and replace the [AWAITING_APPROVAL] marker in the saved messages.
        // The marker format is: "[AWAITING_APPROVAL] tool_call_id=<callId>"
        // We match on the toolName as well (the marker is in the tool-result block
        // whose toolName equals req.toolName and whose output text contains
        // [AWAITING_APPROVAL]). Using toolName for matching is safe because there
        // is at most one pending approval per tool per turn in this design
        // (one approval at a time; siblings are deferred).
        messages = messages.map((msg) => {
          if (
            typeof msg !== 'object' ||
            msg === null ||
            (msg as { role: string }).role !== 'tool'
          ) {
            return msg;
          }
          const toolMsg = msg as { role: 'tool'; content: unknown };
          if (!Array.isArray(toolMsg.content)) return msg;

          const updatedContent = toolMsg.content.map((block: unknown) => {
            if (
              typeof block !== 'object' ||
              block === null ||
              (block as { type: string }).type !== 'tool-result'
            ) {
              return block;
            }
            const tb = block as {
              type: 'tool-result';
              toolCallId: string;
              toolName: string;
              output: ToolResultOutput;
            };
            // Match: same toolName and output contains the [AWAITING_APPROVAL] marker.
            if (tb.toolName !== req.toolName) return block;
            const outputText =
              tb.output.type === 'text' ? tb.output.value : JSON.stringify(tb.output.value);
            if (!outputText.includes('[AWAITING_APPROVAL]')) return block;
            // Replace with the real (or rejection) output.
            return { ...tb, output: replacementOutput };
          });

          return { ...toolMsg, content: updatedContent };
        }) as typeof messages;

        // Stamp executed_at so this request is never re-processed.
        await db
          .update(approvalRequests)
          .set({ executedAt: new Date() })
          .where(eq(approvalRequests.id, req.id));
      }

      // Persist the updated messages before entering the LLM loop.
      await saveCheckpoint(db, jobId as string, {
        messages,
        turn,
        chainCount: job.chainCount ?? 0,
        toolsUsed,
        inputTokens,
        outputTokens,
        effectiveInputTokens,
        servedProvider,
      });
    }

    // If there are still PENDING (unresolved) requests, re-suspend and wait.
    const stillPending = pendingExecRows.filter((r) => r.status === 'pending');
    if (stillPending.length > 0) {
      trace('resume_still_pending', { count: stillPending.length });
      await setJobStatus(db, jobId as string, 'awaiting_approval');
      return { status: 'awaiting_approval' };
    }
  }

  // ── 12. Main LLM loop ─────────────────────────────────────────────────────────
  // An empty LLM turn (no tool calls AND no text) is a transient model glitch —
  // retry the turn a bounded number of times before failing the job loud.
  const MAX_EMPTY_TURN_RETRIES = 2;
  let emptyTurnRetries = 0;
  // Anti-spam guard (invariant 8): count of consecutive turns whose only tool
  // calls were user-facing delivery calls with no return_result. In-memory and
  // intra-run — the spam pattern happens within one continuous run; a resume
  // resets it, which is fine. Reset to 0 by any turn that does real work or
  // calls return_result.
  let consecutiveDeliveryOnlyTurns = 0;
  // Delivery guard (invariant 8, mirror of the anti-spam guard): for a tool-only
  // delivery channel (telegram), a job must deliver at least once via the delivery
  // tool before completing — otherwise the reply is a silent black hole. We flip
  // this true on the first successful telegram_send_message; if a completion path
  // is reached while still false, we re-prompt the agent (bounded) before letting
  // it finish. In-memory/intra-run: in the router/delegation case the parent makes
  // its final send in the same run it finalizes, so the flag is evaluated correctly.
  // Tool-only channels (Telegram) always require a tool delivery. A cron job
  // that opted into a success confirmation (chat_id set by the tick) is held to
  // the same bar: the agent must deliver before completing, otherwise the user
  // never gets the "done" message they asked for.
  const requiresToolDelivery =
    TOOL_ONLY_DELIVERY_CHANNELS.has(job.channel ?? '') || cronWantsConfirmation;
  const MAX_TELEGRAM_REDELIVERY_NUDGES = 2;
  let telegramRedeliveryNudges = 0;
  let telegramDelivered = false;
  // Internal corrective prompt — never sent to the channel; only steers the LLM
  // back to delivering via its tool. Not user-facing text (invariant 2 holds).
  const deliveryNudge =
    "[système] Tu es sur Telegram. Tu n'as pas encore livré ta réponse à l'utilisateur. " +
    'Appelle `telegram_send_message` avec ta réponse, PUIS `return_result`. Ne réponds pas ' +
    'en texte simple — sur Telegram, seul un message envoyé via `telegram_send_message` est ' +
    "visible par l'utilisateur.";

  // Approval heads-up (mirror of the delivery guard). A gated tool creates an
  // approval request and pauses the job WITHOUT executing. On a tool-only
  // delivery channel (Telegram) that pause is otherwise completely silent — the
  // user gets no signal that anything awaits their decision (live incident: job
  // eeb2b587, 2026-05-31). `approvalPending` latches once a gate fires so the
  // completion paths suspend instead of finalizing; the nudge below steers the
  // agent to tell the user, in its own voice via its own tool, what it launched
  // and that it's waiting. The nudge is LLM-channel only (never sent verbatim;
  // invariant 2 holds).
  let approvalPending = false;
  const approvalNudge =
    '[système] Tu es sur Telegram et une de tes actions vient de créer une demande ' +
    "d'approbation : elle attend la validation de l'utilisateur avant de s'exécuter. Avant que " +
    "le job se mette en pause, appelle `telegram_send_message` pour dire à l'utilisateur, avec " +
    'tes propres mots, quelle action tu as lancée et que tu attends son approbation (il la ' +
    "validera depuis le dashboard). N'appelle PAS `return_result` — la mise en pause est " +
    'automatique.';
  // Suspend the job in `awaiting_approval`, persisting the current conversation
  // so the dashboard-driven resume (section 11.7) picks up exactly where we left
  // off. Closes over the loop accumulators (reassigned each turn) by reference.
  const suspendForApproval = async (): Promise<ExecuteJobResult> => {
    await saveCheckpoint(db, jobId as string, {
      messages,
      turn,
      chainCount: job.chainCount ?? 0,
      toolsUsed,
      inputTokens,
      outputTokens,
      effectiveInputTokens,
      servedProvider,
    });
    await setJobStatus(db, jobId as string, 'awaiting_approval');
    return { status: 'awaiting_approval' };
  };

  // ── Reliability guards (generic, channel-agnostic) ────────────────────────
  // Guard 1a — per-job token budget. A loud backstop against runaway loops that
  // stay under the turn cap (e.g. a faux-empty tool reply replayed every turn).
  // Cumulative across resumes via the seeded inputTokens/outputTokens. Env
  // override per-deployment; falls back to the calibrated default.
  const maxTotalTokensPerJob = (() => {
    const raw = process.env['MAX_TOTAL_TOKENS_PER_JOB'];
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMITS.maxTotalTokensPerJob;
  })();
  // Guard 1e — real dollar cost cap. Fail loud before acting on a turn's output
  // when the cumulative billed cost exceeds the cap. Provider-reported cost
  // (OpenRouter: `usage.cost` via providerMetadata.openrouter.usage.cost) is the
  // signal; for providers that don't report cost this guard never fires (cost
  // stays 0) and Guard 1a (token budget) remains the backstop.
  const maxCostPerJobUsd = (() => {
    const raw = process.env['MAX_COST_PER_JOB_USD'];
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMITS.maxCostPerJobUsd;
  })();
  // Guard 1c — context compaction threshold. We evict OLD tool-result bodies
  // before the model's context window overflows (a hard provider error no retry
  // recovers). Trigger = a turn's prompt crossing a fraction of the window.
  //
  // This is a WINDOW guard, NOT a cost lever. Cost is owned by Guard 1a's
  // cache-aware budget (effective = input − cached). Evicting mid-history mutates
  // the prompt prefix, which BUSTS the provider's prompt-cache (Anthropic
  // cache_read / DeepSeek cached_tokens) for every message from the eviction
  // point onward — so the next turn re-pays those as FRESH tokens. Firing it
  // earlier than necessary therefore turns a cheap cached job into an expensive
  // uncached one.
  //
  // Hence the threshold is WINDOW-RELATIVE only. There is NO low absolute default
  // cap: a previous 120K floor fired compaction on a 133K context for a 1M-window
  // model (DeepSeek V4 Pro) that had 900K of headroom, collapsing the cache from
  // 0.9 → 0.08 and pushing JobHunter into token_budget_exceeded. The abs cap is
  // now an explicit opt-out only (LLM_COMPACTION_TOKENS) — unset means "guard the
  // window, nothing else". Verified vs Hermes (per-tool payload caps + caching,
  // no early compaction) and Cowork (no compaction while context fits the window).
  const compactionThreshold = (() => {
    const ctxWindow = modelContextWindow(llmClient.config.provider, llmClient.config.model);
    const fracRaw = Number(process.env['LLM_COMPACTION_FRACTION']);
    const frac = Number.isFinite(fracRaw) && fracRaw > 0 && fracRaw < 1 ? fracRaw : 0.7;
    const absRaw = Number(process.env['LLM_COMPACTION_TOKENS']);
    const abs = Number.isFinite(absRaw) && absRaw > 0 ? absRaw : Infinity;
    return Math.min(Math.floor(frac * ctxWindow), abs);
  })();
  const compactionKeepRecentToolMsgs = (() => {
    const raw = Number(process.env['LLM_COMPACTION_KEEP_TURNS']);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
  })();
  // Concurrency for a turn's independent READ tool calls. Our scrape/search tools
  // are synchronous-blocking (the SDK waits for the actor run), so executing a
  // batch serially makes one turn take minutes — long enough to trip the 5-min
  // orphan-reset and to let the prompt cache go cold between turns. We run reads
  // in concurrency-limited waves instead (what Cowork does: "4 in parallel").
  // Reads are side-effect-free and approval-free, so order doesn't matter and
  // parallelism is safe. Writes/delegation/return_result stay serial + ordered.
  const toolConcurrency = (() => {
    const raw = Number(process.env['LLM_TOOL_CONCURRENCY']);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 6;
  })();
  // Guard 1b — no-progress detector. Sliding history of per-turn tool-call
  // signatures (toolName+input+output). N identical in a row ⇒ the agent is
  // stuck re-asking the same thing; fail loud. In-memory/intra-run. Threshold
  // env-overridable per-deployment; falls back to the calibrated default.
  const recentTurnSignatures: string[] = [];
  const maxNoProgressRepeats = (() => {
    const raw = process.env['MAX_NO_PROGRESS_REPEATS'];
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 2 ? Math.floor(n) : DEFAULT_LIMITS.maxNoProgressRepeats;
  })();

  // Guard 1d — no-delivery runaway detector. Keys on turns without any delivery
  // or return_result call; also tracks same-tool streaks. In-memory/intra-run.
  // Thresholds env-overridable per-deployment; fall back to calibrated defaults.
  const noDeliveryNudgeAt = (() => {
    const n = Number(process.env['NO_DELIVERY_NUDGE_AT']);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LIMITS.noDeliveryNudgeAt;
  })();
  const sameToolStreakNudgeAt = (() => {
    const n = Number(process.env['SAME_TOOL_STREAK_NUDGE_AT']);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LIMITS.sameToolStreakNudgeAt;
  })();
  const maxNoDeliveryNudges = (() => {
    const n = Number(process.env['MAX_NO_DELIVERY_NUDGES']);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LIMITS.maxNoDeliveryNudges;
  })();
  const nudgeSpacing = (() => {
    const n = Number(process.env['NO_DELIVERY_NUDGE_SPACING']);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LIMITS.nudgeSpacing;
  })();
  const noDeliveryFailAt = (() => {
    const n = Number(process.env['NO_DELIVERY_FAIL_AT']);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LIMITS.noDeliveryFailAt;
  })();
  // Per-run state for Guard 1d.
  let turnsSinceDelivery = 0;
  let sameToolStreak = 0;
  let lastSingleToolName: string | null = null;
  let noDeliveryNudgesIssued = 0;
  let turnOfLastNudge = -Infinity;

  // Guard 3b — no-false-success. Tool names whose last outcome this run was a
  // hard error and that were never since re-run successfully. If the agent
  // signals return_result(status='success') while this set is non-empty, it is
  // claiming a success that didn't happen (invariant #4) — defer/nudge, then
  // fail loud. An honest return_result(status='blocked') is always allowed.
  const unresolvedToolFailures = new Set<string>();
  const MAX_UNRESOLVED_FAILURE_NUDGES = 2;
  let unresolvedFailureNudges = 0;

  // A return_result(status='blocked') MUST carry a user-facing reason. If the
  // agent omits it, nudge (bounded) for one before finalizing — never leave the
  // user without an explanation (invariant #4 / explicit product requirement).
  const MAX_BLOCKED_REASON_NUDGES = 2;
  let blockedReasonNudges = 0;

  // A model that calls a tool not in its whitelist gets a bounded chance to
  // self-correct: the mistake is fed back WITH the available tool names (and a
  // "did you mean" hint), so the model can retry with a valid name instead of
  // the job being hard-killed on one hallucinated/abbreviated tool name. Generic
  // — benefits every model, most of all the ones that drop MCP prefixes
  // (minimax/deepseek). After the budget, fail loud (invariant #4 / #8).
  const MAX_UNAVAILABLE_TOOL_NUDGES = 3;
  let unavailableToolNudges = 0;

  try {
    while (true) {
      turn += 1;
      counters.resetTurnToolCalls();

      // Leg 2 — Top-of-turn terminal check (primary zombie-stopper).
      //
      // Checks DB status BEFORE every LLM call. If the row has been set to ANY
      // terminal status by an external writer (orphan reaper, cancellation,
      // another concurrent runner), we stop immediately without calling
      // completeJob/failJob — the row is already terminal and we must not race
      // to overwrite it. `cancelJob` is still called for 'cancelled' so it
      // persists the partial transcript + stats.
      //
      // Previously this only checked for 'cancelled'. The extension to 'failed'
      // and 'completed' is the fix for the zombie-execution bug (F1): the orphan
      // reaper can flip a slow job to 'failed' while the original loop is still
      // running; without this check the loop would continue and completeJob would
      // later overwrite 'failed' → 'completed'. The conditional writers (Leg 3)
      // are a second line of defence; this check is the primary stopper.
      const [statusRow] = await db
        .select({ status: agentJobs.status })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId as string));
      const currentTurnStatus = statusRow?.status;
      if (currentTurnStatus === 'cancelled') {
        trace('cancellation_observed', { turn });
        await cancelJob(db, jobId as string, runStats(), messages);
        return { status: 'cancelled' };
      }
      if (currentTurnStatus === 'failed' || currentTurnStatus === 'completed') {
        trace('terminal_observed_mid_loop', { turn, status: currentTurnStatus });
        return { status: 'already_handled' };
      }

      // Invariant 8: hard turn cap. `turn` is cumulative across resumes (it's
      // seeded from job.turn), so a job that loops — or resumes — without ever
      // calling return_result fails loud here instead of burning tokens until
      // the LLM provider's credit balance runs out. Matches Hermes Agent's
      // per-run iteration budget.
      if (turn > DEFAULT_LIMITS.maxTurns) {
        await failJob(db, jobId as string, 'turn_limit_exceeded', runStats(), messages);
        return { status: 'failed', error: 'turn_limit_exceeded' };
      }

      // a. Validate message structure
      validateMessageStructure(messages);

      // b. Tool choice
      const toolChoice = computeToolChoice({
        isOrchestrator,
        turn,
        hasAdapterTools,
        modelSupportsForcedToolChoice,
      });

      // c. Convert tools to AI SDK format. For the skill-authoring meta-tools,
      // append the live workspace tool list so the model has the real tool names
      // in front of it as it decides to author a skill (see step 10).
      const aiSdkTools: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {};
      for (const [name, toolDef] of toolMap) {
        const description =
          authoringToolsSuffix && (name === 'create_skill' || name === 'update_skill')
            ? toolDef.description + authoringToolsSuffix
            : toolDef.description;
        aiSdkTools[name] = { description, inputSchema: toolDef.inputSchema };
      }

      // d. Call LLM
      // Heartbeat before the (potentially ~300s) LLM call so a slow turn doesn't
      // go stale and get reaped by the 5-min orphan-reset mid-flight.
      await touchJob(db, jobId as string);

      trace('llm_call_start', { turn, msgCount: messages.length });
      // Leg 5 — Heartbeat during LLM call. The pre-call touchJob above covers
      // the moment we start; this interval covers long in-progress calls (e.g.
      // reasoning models that think for 2–5 min). 60s is well inside the 5-min
      // orphan-reset window. The interval is cleared in a finally block so it
      // never leaks past this turn regardless of success/error.
      const hbInterval = setInterval(() => {
        void touchJob(db, jobId as string).catch(() => {});
      }, 60_000);
      let response: Awaited<ReturnType<typeof llmClient.generateText>>;
      try {
        response = await llmClient.generateText({
          system: systemPrompt,
          messages,
          tools: aiSdkTools,
          toolChoice,
        });
      } catch (genErr) {
        // Recoverable: the model named a tool that isn't in its whitelist, so
        // the AI SDK rejected the whole turn before returning. Rather than
        // hard-killing an otherwise-productive job on one bad tool name, feed
        // the mistake back (with the available names + a "did you mean" hint)
        // and retry — bounded. The bad assistant turn was never committed to
        // `messages`, so injecting a corrective user message keeps it valid.
        const badTool =
          genErr instanceof Error
            ? genErr.message.match(/Model tried to call unavailable tool ['"`]([^'"`]+)['"`]/i)?.[1]
            : undefined;
        if (badTool && unavailableToolNudges < MAX_UNAVAILABLE_TOOL_NUDGES) {
          unavailableToolNudges += 1;
          trace('unavailable_tool_nudge', {
            turn,
            badTool,
            attempt: unavailableToolNudges,
            via: 'sdk',
          });
          messages = [
            ...messages,
            {
              role: 'user',
              content: '[système] ' + describeUnavailableTool(badTool, [...toolMap.keys()]),
            } as ModelMessage,
          ];
          continue;
        }
        throw genErr; // not this error, or budget spent → outer catch fails loud
      } finally {
        clearInterval(hbInterval);
      }

      // Accumulate token usage. Some providers may return undefined/NaN for
      // either field — coerce to 0 so we never persist NaN. Local providers
      // (LM Studio, Ollama) sometimes omit usage entirely; that just means
      // those turns won't add to the total, not that the call failed.
      // AI SDK v6 renamed usage fields: promptTokens → inputTokens,
      // completionTokens → outputTokens. Both can be `undefined` when the
      // provider doesn't report usage (local providers like LM Studio /
      // Ollama sometimes omit it) — Number(undefined) is NaN, hence the
      // isFinite guard below.
      const usage = response.usage;
      const promptT = Number(usage?.inputTokens ?? 0);
      const completionT = Number(usage?.outputTokens ?? 0);
      // Prompt-cached reads: the portion of this turn's input served from the
      // provider's cache (Anthropic cache_read, OpenRouter/DeepSeek cached_tokens).
      // The AI SDK reports `inputTokens` as the TOTAL (incl. cached) and
      // `cachedInputTokens` as the cached subset — verified for @ai-sdk/anthropic
      // and @openrouter/ai-sdk-provider. Effective (fresh) input = total − cached.
      const cachedT = Number(usage?.cachedInputTokens ?? 0);
      const promptTok = Number.isFinite(promptT) ? promptT : 0;
      const effectiveT = Math.max(0, promptTok - (Number.isFinite(cachedT) ? cachedT : 0));
      inputTokens += promptTok;
      outputTokens += Number.isFinite(completionT) ? completionT : 0;
      effectiveInputTokens += effectiveT;

      // Accumulate real dollar cost for this call (Guard 1e).
      // OpenRouter reports per-call cost in providerMetadata.openrouter.usage.cost
      // when `usage:{include:true}` is passed (set unconditionally in
      // buildOpenRouterModel). Other providers don't populate this path — the
      // guard below simply won't fire for them (cost stays 0).
      // Safe access: providerMetadata is Record<string, JSONObject>; we read
      // through the chain and coerce to number, guarding NaN and negative values.
      // orMeta: the openrouter sub-object from providerMetadata. Typed as
      // Record<string, unknown> so all child accesses are safe regardless of the
      // upstream's payload shape.
      const orMeta = (
        response.providerMetadata as Record<string, Record<string, unknown> | undefined> | undefined
      )?.['openrouter'] as Record<string, unknown> | undefined;
      const rawCost = (orMeta?.['usage'] as Record<string, unknown> | undefined)?.['cost'];
      const callCostUsd =
        typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : 0;
      totalCostUsd += callCostUsd;
      // Capture the upstream provider name (P0-B: served-upstream observability).
      // OpenRouter sets providerMetadata.openrouter.provider to the upstream that
      // actually served the request (e.g. 'DeepSeek', 'Anthropic'). We keep the
      // last non-empty value across the job so the DB row reflects which upstream
      // handled the bulk of the work.
      const rawProvider = orMeta?.['provider'];
      if (typeof rawProvider === 'string' && rawProvider.length > 0) {
        servedProvider = rawProvider;
      }

      // Guard 1a — token budget, CACHE-AWARE. We charge EFFECTIVE (non-cached)
      // input + output, not raw input. A job that re-sends a prompt-cached
      // history (the common long-running pattern: the growing transcript is read
      // from cache each turn, ~10x cheaper) accrues budget at its real cost, so
      // it no longer dies at the wall like an uncached runaway would. A genuine
      // runaway (fresh tokens every turn) still trips. Fail loud BEFORE acting on
      // this turn's output so a runaway never bleeds the provider's credit dry.
      // Agnostic: no per-agent knowledge. Runaway coverage is unchanged —
      // maxTurns + the no-progress detector remain the loop backstops.
      if (effectiveInputTokens + outputTokens > maxTotalTokensPerJob) {
        trace('token_budget_exceeded', {
          turn,
          effectiveInputTokens,
          inputTokens,
          outputTokens,
          maxTotalTokensPerJob,
        });
        await failJob(db, jobId as string, 'token_budget_exceeded', runStats(), messages);
        return { status: 'failed', error: 'token_budget_exceeded' };
      }

      // Guard 1e — real dollar cost cap. Checked right after Guard 1a so both
      // guards are evaluated before any of the turn's output is acted on.
      // Fires only when the provider actually reported a non-zero cost (i.e.
      // OpenRouter with usage:{include:true}); providers that don't report cost
      // leave totalCostUsd at 0 and this guard never trips — Guard 1a is the
      // fallback for those. Fail loud with cost details for observability.
      if (totalCostUsd > maxCostPerJobUsd) {
        trace('cost_budget_exceeded', {
          turn,
          totalCostUsd,
          callCostUsd,
          maxCostPerJobUsd,
        });
        await failJob(db, jobId as string, 'cost_budget_exceeded', runStats(), messages);
        return { status: 'failed', error: 'cost_budget_exceeded' };
      }

      // Guard 1c — compact when THIS turn's prompt crossed the threshold. Evicting
      // OLD tool-result bodies (keeping the last N turns) shrinks every subsequent
      // prompt, preventing window overflow and bounding cost. `promptT` is this
      // turn's prompt size (not the cumulative budget above).
      if (promptT > compactionThreshold) {
        const ev = compactOldToolResults(messages, compactionKeepRecentToolMsgs);
        if (ev.evicted > 0) {
          messages = ev.messages;
          trace('context_compacted', {
            turn,
            promptTokens: promptT,
            threshold: compactionThreshold,
            evictedToolResults: ev.evicted,
          });
        }
      }

      const rawToolCalls = response.toolCalls ?? [];
      trace('llm_call_done', {
        turn,
        toolCalls: rawToolCalls.map((tc) => tc.toolName),
        textLen: (response.text ?? '').length,
        usage: {
          in: promptTok,
          cached: cachedT,
          effective: effectiveT,
          cacheRatio: promptTok > 0 ? Number((cachedT / promptTok).toFixed(2)) : 0,
          out: completionT,
          costUsd: callCostUsd > 0 ? callCostUsd : undefined,
          totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
        },
        ...(servedProvider ? { servedProvider } : {}),
      });

      // e-pré. Anti-spam guard (invariant 8). A "delivery-only" turn is one
      // whose tool calls are ALL user-facing sends (no return_result, no other
      // work). A well-behaved agent batches its reply into ONE such turn then
      // calls return_result; repeating delivery-only turns means it's
      // monologuing one message per turn at the user. Fail loud BEFORE building
      // the assistant message or executing the sends, so the (N+1)th batch
      // never reaches the user. Live incident: job 9bbdbfd7 (2026-05-29) sent
      // 11 filler/emoji messages this way.
      const isDeliveryOnlyTurn =
        rawToolCalls.length > 0 && rawToolCalls.every((tc) => DELIVERY_TOOL_NAMES.has(tc.toolName));
      consecutiveDeliveryOnlyTurns = isDeliveryOnlyTurn ? consecutiveDeliveryOnlyTurns + 1 : 0;
      if (consecutiveDeliveryOnlyTurns > DEFAULT_LIMITS.maxConsecutiveDeliveryTurns) {
        trace('delivery_spam_guard', { turn, consecutiveDeliveryOnlyTurns });
        await failJob(db, jobId as string, 'delivery_spam_guard', runStats(), messages);
        return { status: 'failed', error: 'delivery_spam_guard' };
      }

      // e. Append the assistant turn. Build it from the TYPED response accessors:
      // the model's REASONING parts (response.reasoning — already shaped as
      // message content, carrying the provider metadata a reasoning model needs
      // to round-trip its chain-of-thought across tool calls), then the tool-call
      // parts built from rawToolCalls. The tool calls come from rawToolCalls (NOT
      // response.response.messages) on purpose: those are the exact calls we
      // execute and produce a tool_result for below, so the tool_use ↔
      // tool_result pairing can never drift. (A reasoning model on OpenRouter can
      // surface a tool call in the response *message* that isn't in
      // response.toolCalls; replaying that leaves an unmatched tool_use and fails
      // message-structure validation — live regression: job 8fc974fb, MiniMax M3.)
      const reasoningParts = response.reasoning ?? [];
      // HARNESS FIX: when a turn has BOTH a written answer (response.text) AND
      // tool calls, KEEP the text. Previously the text was dropped whenever tool
      // calls were present, so a model that writes its report as text alongside
      // return_result/dashboard_publish lost the whole report — it never reached
      // the persisted transcript, so result-capture/delivery found nothing. The
      // text part is placed before the tool-call parts (valid assistant content
      // shape for both Anthropic and OpenAI formats).
      const hasText = (response.text ?? '').trim().length > 0;
      const assistantMsg: ModelMessage = {
        role: 'assistant',
        content:
          rawToolCalls.length > 0
            ? [
                ...reasoningParts,
                ...(hasText ? [{ type: 'text' as const, text: response.text || '' }] : []),
                ...rawToolCalls.map((tc) => ({
                  type: 'tool-call' as const,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  input: tc.input as Record<string, unknown>,
                })),
              ]
            : reasoningParts.length > 0
              ? [...reasoningParts, { type: 'text' as const, text: response.text || '' }]
              : response.text || '',
      };
      messages = [...messages, assistantMsg];

      // f. Note return_result presence — but do NOT short-circuit. If the LLM
      // returns it alongside other tools (e.g. [create_task, return_result]),
      // we must execute the others first. Finalization happens at step (j+).
      const returnResultCall = rawToolCalls.find((tc) => tc.toolName === 'return_result');

      // g. No tool calls
      if (rawToolCalls.length === 0) {
        trace('no_tool_calls_branch', { turn, hasText: Boolean(response.text) });
        // An approval is pending (a gate fired on a prior turn) and the agent
        // produced no tool call this turn. We must NOT complete or fail — the
        // request still needs the user's decision. Suspend; the dashboard resume
        // will continue. (Plain text can't reach a Telegram user anyway, and the
        // heads-up nudge already had its bounded turns above.)
        if (approvalPending) {
          return await suspendForApproval();
        }
        const textContent = response.text ?? '';
        if (textContent) {
          // Delivery guard: on a tool-only channel, a plain-text answer was NOT
          // delivered to the user (only the tool reaches them). Re-prompt the
          // agent to resend via its tool instead of silently completing. Live
          // incident: job 5d84d72e (2026-05-29) completed with the reply only in
          // agent_jobs.result — the Telegram user saw nothing.
          if (requiresToolDelivery && !telegramDelivered) {
            if (telegramRedeliveryNudges < MAX_TELEGRAM_REDELIVERY_NUDGES) {
              telegramRedeliveryNudges += 1;
              trace('telegram_redelivery_nudge', {
                turn,
                attempt: telegramRedeliveryNudges,
                via: 'text_branch',
              });
              messages = [...messages, { role: 'user', content: deliveryNudge } as ModelMessage];
              continue;
            }
            trace('telegram_not_delivered', { turn, via: 'text_branch' });
            await failJob(db, jobId as string, 'telegram_not_delivered', runStats(), messages);
            return { status: 'failed', error: 'telegram_not_delivered' };
          }
          const completedText = await completeJob(
            db,
            jobId as string,
            textContent,
            toolsUsed,
            runStats(),
            messages,
          );
          if (!completedText) {
            trace('terminal_write_lost_race', { turn, writer: 'completeJob_text', jobId });
          } else {
            // Fire-and-forget Tier-1 reflection (OFF by default). MUST NOT block
            // or delay the job response — gates + throttle live inside the hook.
            // Snapshot carries the FINAL state (in-memory `job` is still
            // pre-completion). Only runs when completeJob won the terminal write.
            void maybeRunReflection(
              deps,
              db,
              {
                ...job,
                status: 'completed',
                turn,
                toolsUsed,
                messages,
              },
              runnerEnv,
            ).catch((e) => console.warn('[reflection]', e));
          }
          return { status: 'completed', result: textContent };
        }
        // No text AND no tool calls — an empty LLM turn. Transient (the model
        // occasionally returns a blank completion); retry a bounded number of
        // times before failing. Drop the empty assistant message just appended
        // so the retry re-sends a clean context.
        if (emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
          emptyTurnRetries += 1;
          trace('empty_turn_retry', { turn, attempt: emptyTurnRetries });
          // Drop the empty assistant turn just appended so the retry re-sends a
          // clean context.
          messages = messages.slice(0, -1);
          continue;
        }
        // Retry budget exhausted — drop the empty assistant turn we just
        // appended so the persisted transcript ends cleanly, then fail loud
        // (invariant 4). failJob now persists this transcript for diagnosis.
        messages = messages.slice(0, -1);
        await failJob(db, jobId as string, 'no_tool_calls_no_text', runStats(), messages);
        return { status: 'failed', error: 'no_tool_calls_no_text' };
      }

      // h. Filter delegation calls to one-per-turn
      const rawCallBlocks = rawToolCalls.map((tc) => ({
        type: 'tool_use' as const,
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.input as Record<string, unknown>,
      }));

      const {
        kept: keptAssign,
        dropped: droppedAssign,
        others,
      } = filterToolCallsForDelegation(rawCallBlocks);
      const sideToolResults = buildDeferredToolResults(droppedAssign);
      // Strip return_result from the for-loop processing — it's handled
      // separately after the loop so we can execute siblings (e.g. create_task)
      // before finalizing. Without this, an LLM that emits both in one turn
      // would have its real work discarded.
      const othersWithoutReturn = others.filter((b) => b.name !== 'return_result');
      // Order matters: non-assign tool calls (save_memory, query_memory, etc.)
      // run FIRST, then the assign call. If the assign triggers delegation,
      // the loop exits via recursive executeJob — anything queued AFTER would
      // be silently dropped, leaving the LLM's tool_use blocks unmatched at
      // resume time (unmatched_tool_use error). Their results are forwarded to
      // handleDelegation as sideToolResults so resumeDelegated re-injects them.
      const callsToProcess = keptAssign
        ? [...othersWithoutReturn, keptAssign]
        : othersWithoutReturn;

      // i. Process tool calls. AI SDK v6 ToolResultPart shape:
      //   { type: 'tool-result', toolCallId, toolName, output: ToolResultOutput }
      // where ToolResultOutput is the discriminated union defined at step 11.6.
      const toolResultBlocks: Array<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        output: ToolResultOutput;
      }> = [];

      // A model can emit return_result MORE than once in a turn (minimax does).
      // Only the first (returnResultCall) finalizes the job; the rest are stripped
      // from the for-loop above, so without a synthetic result their tool_use
      // blocks are left unmatched → message_structure_invalid:unmatched_tool_use
      // on the next turn (live: job 777d2730 emitted return_result x2, 1 result).
      // Seed an "ignored duplicate" result for each extra so every tool_use is
      // matched whichever exit path the return_result branch takes.
      for (const tc of rawToolCalls) {
        if (tc.toolName === 'return_result' && tc.toolCallId !== returnResultCall?.toolCallId) {
          toolResultBlocks.push({
            type: 'tool-result',
            toolCallId: tc.toolCallId,
            toolName: 'return_result',
            output: toResultOutput({
              error:
                'ignored: duplicate return_result in the same turn — only the first is honored',
            }),
          });
        }
      }

      let awaitingApproval = false;

      // Parallel pre-pass: when EVERY tool call this turn is an independent READ
      // (no delegation, no writes, no return_result), run them in
      // concurrency-limited waves and cache the results. The serial loop below
      // then consumes the cache instead of blocking on each call. This is the
      // fix for sync-blocking scrape batches: a 19-read turn finishes in ~3 waves
      // (~tens of seconds) instead of 19 serial ~25s calls (~8 min) — which kept
      // the prompt cache cold and tripped the 5-min orphan-reset. Reads are
      // side-effect-free and approval-free, so concurrency can't reorder state or
      // skip an approval gate. Any write/delegation tool in the turn → serial path.
      const sharedToolCtx = {
        jobId: jobId as string,
        agentId: agentRow.id,
        entityId: job.entityId ?? '',
        db,
        jobChatId: job.chatId ?? null,
        embeddingClient: deps.embeddingClient,
        workspaces: agentWorkspacesList,
        skillStoreDir: skillStore,
        assignedSkillSlugs,
        scriptAuthorizedSkillSlugs,
        provisioning: TOOL_PROVISIONING,
      };
      const sharedToolOpts = {
        approvalRules: approvalRuleList,
        autonomy: workspaceAutonomy,
        onApprovalRequired: async () => {},
      };
      const preExecuted = new Map<string, Awaited<ReturnType<typeof executeTool>>>();
      const parallelizable =
        callsToProcess.length > 1 &&
        callsToProcess.every(
          (c) => !c.name.startsWith('assign_') && toolMap.get(c.name)?.riskLevel === 'read',
        );
      if (parallelizable) {
        // Cap at the per-turn tool budget so we never execute past the limit the
        // serial loop would enforce.
        const batch = callsToProcess.slice(0, DEFAULT_LIMITS.maxToolCallsPerTurn);
        trace('parallel_tool_prepass', { turn, count: batch.length, concurrency: toolConcurrency });
        for (let i = 0; i < batch.length; i += toolConcurrency) {
          const wave = batch.slice(i, i + toolConcurrency);
          const results = await Promise.all(
            wave.map(async (c) => {
              const def = toolMap.get(c.name);
              if (!def) return { id: c.id, r: null };
              return {
                id: c.id,
                r: await executeTool(def, c.input, sharedToolCtx, sharedToolOpts),
              };
            }),
          );
          for (const { id, r } of results) if (r) preExecuted.set(id, r);
          // Heartbeat after each wave so a long batch isn't reaped as orphaned.
          await touchJob(db, jobId as string);
        }
      }

      for (const call of callsToProcess) {
        // Bug A fix: if a prior tool in this turn needed approval, do NOT execute
        // subsequent tool calls. Inject a [DEFERRED] marker so every tool_use block
        // has a matching tool_result — without this the saved messages are invalid
        // (unmatched_tool_use) and the job cannot resume. The LLM will re-issue
        // these calls once the pending approval is resolved.
        if (awaitingApproval) {
          toolResultBlocks.push({
            type: 'tool-result',
            toolCallId: call.id,
            toolName: call.name,
            output: toResultOutput(
              '[DEFERRED] a prior action in this turn is awaiting approval; re-issue this call after it resolves.',
            ),
          });
          continue;
        }

        counters.bumpToolCall();
        toolsUsed = [...new Set([...toolsUsed, call.name])];

        const toolDef = toolMap.get(call.name);
        if (!toolDef) {
          // Recoverable (mirrors the deferred-approval pattern above): feed the
          // unavailable-tool mistake back as THIS call's tool-result so the
          // message-structure invariant holds (every tool_use gets a
          // tool_result) and the model can retry with a valid name. Bounded;
          // after the budget, fail loud (invariant #4 / #8).
          if (unavailableToolNudges < MAX_UNAVAILABLE_TOOL_NUDGES) {
            unavailableToolNudges += 1;
            trace('unavailable_tool_nudge', {
              turn,
              badTool: call.name,
              attempt: unavailableToolNudges,
              via: 'toolMap',
            });
            toolResultBlocks.push({
              type: 'tool-result',
              toolCallId: call.id,
              toolName: call.name,
              output: toResultOutput({
                error: describeUnavailableTool(call.name, [...toolMap.keys()]),
              }),
            });
            continue;
          }
          await failJob(
            db,
            jobId as string,
            `whitelist_violation:${call.name}`,
            runStats(),
            messages,
            `L'agent a appelé à répétition un outil indisponible (${call.name}).`,
          );
          return { status: 'failed', error: `whitelist_violation:${call.name}` };
        }

        if (call.name.startsWith('assign_')) {
          const childSlug = call.name.replace(/^assign_/, '').replace(/_/g, '-');

          // Unified-orchestrator commit guard. A job that already fanned out via
          // create_task is a PLANNER job — its completion runs through the task
          // board (awaiting_tasks → deliverCompletedRoots). Honoring an assign_
          // here would ALSO suspend it into the router's awaiting_delegation,
          // colliding the two completion models on one row. Defer the assign_
          // (and flush its deferred siblings so every tool_use stays matched) so
          // the job keeps the delegation style it committed to first. Within a
          // turn this fires because create_task is processed before the assign_;
          // across turns because the tasks persist.
          const [committedToTasks] = await db
            .select({ id: agentTasks.id })
            .from(agentTasks)
            .where(eq(agentTasks.rootJobId, jobId as string))
            .limit(1);
          if (committedToTasks) {
            toolResultBlocks.push({
              type: 'tool-result',
              toolCallId: call.id,
              toolName: call.name,
              output: toResultOutput({
                error:
                  'deferred: this job already delegates via the task board (create_task). Do NOT also assign_ — let the tasks run and compile, or add more parallel work with create_task. Mixing both delegation styles on one job is not allowed.',
              }),
            });
            for (const sr of sideToolResults) {
              toolResultBlocks.push({
                type: 'tool-result',
                toolCallId: sr.tool_use_id,
                toolName: sr.toolName,
                output: toResultOutput({ error: sr.content }),
              });
            }
            continue;
          }

          // Per-slug naive-retry block. `resumeDelegated` set
          // `last_failed_delegation_slug` to the slug of the last failed child;
          // it's cleared on any successful delegation. We refuse only when the
          // parent's LLM is re-emitting `assign_<sameSlug>` right after that
          // slug failed. Falling back to a DIFFERENT specialist (per the new
          // Conciergus personality) is allowed — that's the legitimate
          // alternative strategy after an upstream failure.
          //
          // Live regression that motivated the per-slug refactor: job
          // `7767a3c1` (2026-05-19) — global counter blocked Conciergus's
          // fallback to Obsidius after Summarizus timeout, killing the
          // whole workflow when one specialist would have succeeded.
          if (job.lastFailedDelegationSlug === childSlug) {
            toolResultBlocks.push({
              type: 'tool-result',
              toolCallId: call.id,
              toolName: call.name,
              output: toResultOutput({
                error: `delegation_retry_blocked: assign_${call.name.slice('assign_'.length)} already failed once on this job — do NOT retry the same specialist. Either fall back to a different specialist (assign_<otherSlug>) or notify the user via telegram_send_message and call return_result with status='blocked'.`,
              }),
            });

            // Flush the deferred siblings (other assign_* calls that the LLM
            // emitted in the same turn but `filterToolCallsForDelegation`
            // dropped to keep one-per-turn). In the normal delegation path
            // `handleDelegation` persists these in `pending_delegation` and
            // `resumeDelegated` re-injects them. The cap-refusal path skips
            // `handleDelegation` entirely, so without this loop the dropped
            // tool_use blocks land in messages with no matching tool_result —
            // next LLM call trips `message_structure_invalid:unmatched_tool_use`
            // and the whole job dies. Live regression: job `a5ac5d6e`
            // (2026-05-18) — Conciergus issued 2 parallel `assign_summarizer`
            // while cap was already at 1, only the first received a refusal
            // tool_result, the second stayed orphan, job failed at turn 7.
            for (const sr of sideToolResults) {
              toolResultBlocks.push({
                type: 'tool-result',
                toolCallId: sr.tool_use_id,
                toolName: sr.toolName,
                output: toResultOutput({ error: sr.content }),
              });
            }
            continue;
          }

          try {
            await executeTool(
              toolDef,
              call.input,
              {
                jobId: jobId as string,
                agentId: agentRow.id,
                entityId: job.entityId ?? '',
                db,
                jobChatId: job.chatId ?? null,
                embeddingClient: deps.embeddingClient,
                workspaces: agentWorkspacesList,
                skillStoreDir: skillStore,
                assignedSkillSlugs,
                scriptAuthorizedSkillSlugs,
                provisioning: TOOL_PROVISIONING,
              },
              {
                approvalRules: approvalRuleList,
                autonomy: workspaceAutonomy,
                onApprovalRequired: async () => {},
              },
            );
          } catch (err) {
            if (err instanceof DelegationPendingError) {
              counters.bumpDelegationDepth();

              // Track the assign_* call in toolsUsed BEFORE persisting — without
              // this the parent loses its turn-1 tool list across the suspend.
              toolsUsed = [...new Set([...toolsUsed, call.name])];

              // Persist run-state (turn, tokens, toolsUsed) before transitioning
              // to awaiting_delegation. handleDelegation persists messages +
              // status atomically; this complements it for observability.
              await saveCheckpoint(db, jobId as string, {
                messages,
                turn,
                chainCount: job.chainCount ?? 0,
                toolsUsed,
                inputTokens,
                outputTokens,
                effectiveInputTokens,
                servedProvider,
              });

              const jobShape = {
                id: jobId,
                agentId: agent.id,
                entityId: (job.entityId ?? null) as EntityId | null,
                status: 'processing',
                messages,
                pendingDelegation: null,
                chainCount: job.chainCount ?? 0,
                delegationDepth: job.delegationDepth ?? 0,
                parentJobId: (job.parentJobId ?? null) as JobId | null,
                task: job.task,
                channel: job.channel,
                chatId: job.chatId,
              };

              // Forward any non-assign tool results we already executed in this
              // turn (e.g. save_memory ran before the assign) as additional
              // sideToolResults. Without this, the LLM's earlier tool_use
              // blocks have no matching tool_result on resume → unmatched_tool_use.
              const preAssignSideResults = toolResultBlocks.map((b) => ({
                type: 'tool_result' as const,
                tool_use_id: b.toolCallId,
                toolName: b.toolName,
                content:
                  b.output.type === 'text'
                    ? b.output.value
                    : JSON.stringify(b.output.value ?? null),
              }));

              const delegation = await handleDelegation(
                jobShape,
                childSlug,
                call.id,
                {
                  task: (call.input['task'] as string) ?? '',
                  data: call.input['data'] as string | undefined,
                  chatId: job.chatId,
                },
                [...sideToolResults, ...preAssignSideResults],
                db,
              );

              // Drive the child synchronously, then resume the parent. In
              // single-process local mode this is the simplest correct flow:
              // no queue, no orphaned children, no separate delivery cron.
              // The recursion is bounded by DelegationDepthExceededError
              // (max 3) thrown from bumpDelegationDepth above.
              const childOutcome = await executeJob(delegation.childJobId, deps, runnerEnv, {
                inlineDelegation: true,
              });

              if (childOutcome.status === 'failed') {
                // Prefer the child's user-facing reason (e.g. an agent_blocked
                // explanation) over the bare error code, so the parent can relay
                // WHY the child stopped — not just that it did.
                const childErr = childOutcome.result || childOutcome.error || 'unknown';
                // Surface the failure as a tool_result so the parent's LLM can
                // react (notify the user via telegram_send_message, try another
                // sub-agent, return_result{status:'blocked'}, etc.) instead of
                // dying silently. Anti-loop: resumeDelegated bumps chainCount;
                // a parent that keeps delegating on every failure will hit
                // chain_limit_exceeded (max 15 chains, invariant #8).
                //
                // Live regression — job `56a3a1b5` (2026-05-17): Conciergus
                // delegated to Summarizus, child failed at turn 5, parent died
                // immediately with `child_failed:Retry exhausted` and the user
                // got NOTHING back on Telegram after 8 minutes of work.
                await resumeDelegated(
                  jobId as JobId,
                  delegation.childJobId,
                  { error: childErr },
                  db,
                );
                return runJob(jobId, deps, runnerEnv, opts);
              }

              if (childOutcome.status === 'cancelled') {
                // The user cancelled the child mid-flight. Cascade: a parent
                // whose only outstanding work was the child has nothing left
                // to do. Flip the parent to cancelled too (the DB row may
                // still be 'processing' since cancellation was scoped to the
                // child); orphan-cleanup would catch it eventually but
                // surfacing it now matches user intent.
                await db
                  .update(agentJobs)
                  .set({ status: 'cancelled', updatedAt: new Date() })
                  .where(eq(agentJobs.id, jobId as string));
                await cancelJob(db, jobId as string, runStats(), messages);
                return { status: 'cancelled' };
              }

              if (childOutcome.status !== 'completed') {
                // Child SUSPENDED (awaiting approval / its own sub-delegation /
                // awaiting_tasks). The parent is already persisted in
                // `awaiting_delegation` (pending_delegation → this child) by
                // handleDelegation, so leave it suspended and return — do NOT
                // fail. When the child is later resumed (e.g. the user approves
                // the gated command) and finishes, the child's executeJob wrapper
                // calls maybeResumeParent, which resumes THIS parent and
                // re-triggers it. Nested delegation + approval resume path.
                return { status: 'awaiting_delegation' };
              }

              // Inject child's result as tool_result on the parent and flip
              // status back to 'pending' so we can re-enter executeJob.
              await resumeDelegated(jobId as JobId, delegation.childJobId, childOutcome.result, db);

              return runJob(jobId, deps, runnerEnv, opts);
            }
            throw err;
          }

          continue;
        }

        // Non-delegation tool
        // Reuse the result if this read was already run in the parallel pre-pass;
        // otherwise execute now (writes, single-tool turns, mixed turns).
        const toolResult =
          preExecuted.get(call.id) ??
          (await executeTool(toolDef, call.input, sharedToolCtx, sharedToolOpts));

        if (toolResult.outcome === 'awaiting_approval') {
          const awaitingMarker = `[AWAITING_APPROVAL] tool_call_id=${call.id}`;
          toolResultBlocks.push({
            type: 'tool-result',
            toolCallId: call.id,
            toolName: call.name,
            output: toResultOutput(awaitingMarker),
          });
          awaitingApproval = true;
          // Bug A fix: do NOT break here. Mark the flag and continue the loop
          // to flush remaining tool calls as [DEFERRED] markers so every
          // tool_use block in this turn has a matching tool_result. Without
          // this, the message structure is invalid on resume (unmatched_tool_use).
          continue;
        }

        // Delivery guard: record a successful user-facing delivery so the
        // completion paths know the user actually received something.
        if (toolResult.outcome === 'success' && DELIVERY_TOOL_NAMES.has(call.name)) {
          telegramDelivered = true;
        }

        // Guard 3b — track unresolved hard tool failures across turns. A success
        // clears any prior failure of the same tool (the agent retried and it
        // worked); a fresh error marks it unresolved. (awaiting_approval was
        // handled above with `continue`, so outcome here is success|error.)
        if (toolResult.outcome === 'success') {
          unresolvedToolFailures.delete(call.name);
        } else {
          unresolvedToolFailures.add(call.name);
        }

        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: call.id,
          toolName: call.name,
          output: toResultOutput(
            toolResult.outcome === 'success' ? toolResult.output : { error: toolResult.error },
          ),
        });
      }

      // j. Suspension states — approval gate.
      //
      // A gated tool created an approval request and did NOT execute. `awaitingApproval`
      // is per-turn; `approvalPending` latches across turns so the heads-up turn
      // (below) cannot slip through to a completion path. Before going silent on
      // a tool-only channel (Telegram), we give the agent up to MAX bounded turns
      // to tell the user — in its own voice, via its own delivery tool — what it
      // launched and that it's waiting for approval. Once delivered (or budget
      // spent, or not a tool-only channel) we suspend; the user resolves the
      // request from the dashboard, which resumes the job (section 11.7 executes
      // the approved tool). Live incident: job eeb2b587 (2026-05-31) suspended on
      // a gated `attach_skill` with zero Telegram signal to the user.
      if (awaitingApproval) {
        approvalPending = true;
      }
      if (approvalPending) {
        // Keep the saved conversation valid for resume: every tool_use needs a
        // matching tool_result. Gated/deferred markers are already in
        // toolResultBlocks; synthesize one for return_result if the agent emitted
        // it this turn — we are NOT finalizing while an approval is pending.
        if (returnResultCall && !toolResultBlocks.some((b) => b.toolName === 'return_result')) {
          toolResultBlocks.push({
            type: 'tool-result',
            toolCallId: returnResultCall.toolCallId,
            toolName: 'return_result',
            output: toResultOutput({ error: 'deferred: an action is awaiting user approval' }),
          });
        }
        if (toolResultBlocks.length > 0) {
          messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
        }
        if (
          requiresToolDelivery &&
          !telegramDelivered &&
          telegramRedeliveryNudges < MAX_TELEGRAM_REDELIVERY_NUDGES
        ) {
          telegramRedeliveryNudges += 1;
          trace('telegram_approval_nudge', { turn, attempt: telegramRedeliveryNudges });
          messages = [...messages, { role: 'user', content: approvalNudge } as ModelMessage];
          continue;
        }
        return await suspendForApproval();
      }

      // j-pré. Detect tool errors in the same turn as return_result. If a
      // sibling tool errored, do NOT finalize: inject the error into messages
      // and re-loop so the LLM sees it next turn. Without this guard, a turn
      // like [telegram_send_message (error), return_result] would silently
      // finalize the job claiming success even though the side-effect failed
      // — direct violation of invariant #4 (no silent fallbacks).
      // A "sibling tool error" is one whose tool_result output is a JSON
      // object containing an `error` field (the shape we wrap failures in
      // — see toResultOutput callers in section i above).
      const isToolErrorBlock = (block: (typeof toolResultBlocks)[number]): boolean =>
        block.toolName !== 'return_result' &&
        block.output.type === 'json' &&
        block.output.value !== null &&
        typeof block.output.value === 'object' &&
        'error' in (block.output.value as Record<string, unknown>);

      const turnHadSiblingToolError =
        returnResultCall !== undefined && toolResultBlocks.some(isToolErrorBlock);

      if (returnResultCall && turnHadSiblingToolError) {
        const erroredTools = toolResultBlocks.filter(isToolErrorBlock).map((b) => b.toolName);
        trace('return_result_skipped_due_to_tool_error', { turn, erroredTools });

        // Synthesize a tool-result for return_result so the message-structure
        // invariant holds (every tool_use must have a matching tool_result).
        // The LLM gets to see both the sibling errors AND a "deferred" marker
        // for return_result, then chooses whether to retry the failed tool or
        // call return_result again with status='blocked'.
        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: returnResultCall.toolCallId,
          toolName: 'return_result',
          output: toResultOutput({ error: 'deferred: sibling tool error must be addressed first' }),
        });
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
        continue;
      }

      // j-bis. return_result finalization — runs AFTER all sibling tools have
      // executed, so a turn like [create_task, return_result] still creates the
      // task before completing. The synthetic tool-result for return_result is
      // appended alongside other tool-results to satisfy the message-structure
      // invariant (every tool_use has a matching tool_result).
      if (returnResultCall) {
        trace('return_result_branch', { turn });

        // Guard 3b — refuse a false 'success'. If the agent signals success while
        // a hard tool failure from an earlier turn was never resolved, it is
        // claiming an action/delivery that never happened (invariant #4 — no
        // silent fallback). Nudge it (bounded) to either retry the action to
        // success or honestly return status='blocked'; once the budget is spent,
        // fail loud. An honest status='blocked' passes straight through.
        const rrStatus = (returnResultCall.input as { status?: string } | undefined)?.status;

        // ── status='blocked' — honest, explained termination ──────────────────
        // A blocked task must NEVER leave the user without an explanation. We
        // (1) require a reason — nudging the agent if it omitted one; (2) for a
        // tool-delivery channel, make the agent deliver that reason via its
        // channel tool so the user actually receives it; (3) finalize as
        // 'failed' (error='agent_blocked') with the reason persisted to the
        // user-facing result — never a fake 'completed'.
        if (rrStatus === 'blocked') {
          const reason = (
            (returnResultCall.input as { reason?: string } | undefined)?.reason ?? ''
          ).trim();

          // L1 — no reason: nudge (bounded) for a concrete, user-facing one.
          if (reason === '' && blockedReasonNudges < MAX_BLOCKED_REASON_NUDGES) {
            blockedReasonNudges += 1;
            trace('blocked_reason_nudge', { turn, attempt: blockedReasonNudges });
            toolResultBlocks.push({
              type: 'tool-result',
              toolCallId: returnResultCall.toolCallId,
              toolName: 'return_result',
              output: toResultOutput({
                error:
                  "deferred: status='blocked' exige un champ `reason`. Rappelle return_result " +
                  'avec une raison concrète et actionnable expliquant ce qui te bloque et ce que ' +
                  "l'utilisateur peut faire — il la verra telle quelle.",
              }),
            });
            messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
            messages = [
              ...messages,
              {
                role: 'user',
                content:
                  "[système] Tu t'es déclaré bloqué sans raison. Donne une raison concrète dans " +
                  '`reason` (ce qui bloque + ce que l’utilisateur peut faire).',
              } as ModelMessage,
            ];
            continue;
          }

          // L2-delivery — on a tool-delivery channel, the user only sees what the
          // agent sends. If the reason wasn't delivered, nudge (bounded, shared
          // budget) the agent to send it via its channel tool before we finalize.
          if (
            reason !== '' &&
            requiresToolDelivery &&
            !telegramDelivered &&
            telegramRedeliveryNudges < MAX_TELEGRAM_REDELIVERY_NUDGES
          ) {
            telegramRedeliveryNudges += 1;
            trace('blocked_delivery_nudge', { turn, attempt: telegramRedeliveryNudges });
            toolResultBlocks.push({
              type: 'tool-result',
              toolCallId: returnResultCall.toolCallId,
              toolName: 'return_result',
              output: toResultOutput({
                error:
                  "deferred: tu es bloqué mais l'utilisateur n'a rien reçu. Envoie d'abord ta " +
                  'raison via ton outil de livraison (telegram_send_message), puis rappelle ' +
                  "return_result avec status='blocked'.",
              }),
            });
            messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
            messages = [...messages, { role: 'user', content: deliveryNudge } as ModelMessage];
            continue;
          }

          // Finalize. Synthetic tool-result keeps the message-structure invariant.
          // failJob writes the user-facing result: the agent's reason when present,
          // else a generic backstop (L3) — never silence, never a fake 'completed'.
          trace('return_result_blocked', { turn, hasReason: reason !== '' });
          toolResultBlocks.push({
            type: 'tool-result',
            toolCallId: returnResultCall.toolCallId,
            toolName: 'return_result',
            output: toResultOutput({ acknowledged: true }),
          });
          messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
          toolsUsed = [...new Set([...toolsUsed, 'return_result'])];

          // The error column carries a SHORT human reason (first sentence) so the
          // UI shows a readable "why" instead of the opaque code; the full reason
          // lives in result (failJob fills it when no delivery tool already did).
          const errorMessage = shortBlockReason(reason);
          const resultMessage = reason || BLOCK_NO_REASON;
          await failJob(db, jobId as string, errorMessage, runStats(), messages, resultMessage);
          trace('exit_blocked_via_return_result', { hasReason: reason !== '' });
          // Carry the reason so a delegating parent can relay WHY we stopped.
          return { status: 'failed', error: errorMessage, result: resultMessage };
        }

        if (rrStatus === 'success' && unresolvedToolFailures.size > 0) {
          const stuck = [...unresolvedToolFailures];
          // A 'success' is only FALSE when the user got nothing — i.e. a DELIVERY
          // tool failed (telegram_send_message / send_image / dashboard_publish).
          // Benign, non-retryable side-tool failures (a deduped comment, a vote on
          // OWN content) while the agent HAS delivered are NOT a false success:
          // the deliverable is honest and the failures stay visible in the
          // persisted transcript. Hard-failing those turned complete, productive
          // jobs into false FAILURES (live: Java/Cortex sessions did all the work,
          // then died on unresolved_tool_failure over a self-vote/dedup rejection
          // the agent literally cannot retry to success). The telegram-delivery
          // guard below independently catches "nothing delivered on a tool-only
          // channel".
          const stuckDelivery = stuck.filter((t) => DELIVERY_OR_TERMINAL_TOOL_NAMES.has(t));
          if (stuckDelivery.length > 0) {
            if (unresolvedFailureNudges < MAX_UNRESOLVED_FAILURE_NUDGES) {
              unresolvedFailureNudges += 1;
              trace('unresolved_tool_failure_nudge', {
                turn,
                attempt: unresolvedFailureNudges,
                stuck: stuckDelivery,
              });
              toolResultBlocks.push({
                type: 'tool-result',
                toolCallId: returnResultCall.toolCallId,
                toolName: 'return_result',
                output: toResultOutput({
                  error:
                    'deferred: tu signales success mais ta livraison a échoué sans être corrigée (' +
                    stuckDelivery.join(', ') +
                    "). Réessaie la livraison jusqu'à réussite, ou appelle return_result avec status='blocked'.",
                }),
              });
              messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
              messages = [
                ...messages,
                {
                  role: 'user',
                  content:
                    "[système] Ne déclare pas un succès qui n'a pas eu lieu. Ta livraison à " +
                    "l'utilisateur a échoué et n'a pas été corrigée. Corrige-la, ou termine " +
                    "honnêtement avec status='blocked'.",
                } as ModelMessage,
              ];
              continue;
            }
            trace('unresolved_tool_failure', { turn, stuck: stuckDelivery });
            await failJob(db, jobId as string, 'unresolved_tool_failure', runStats(), messages);
            return { status: 'failed', error: 'unresolved_tool_failure' };
          }
          // Only non-delivery side-tool failures remain → NOT a false success.
          // Accept it and fall through to normal completion; the failed calls
          // stay recorded in the persisted transcript (invariant #4: not silent).
          trace('unresolved_side_tool_failures_accepted', { turn, stuck });
        }

        // Resolve the task-board state up front: a run that created tasks
        // delivers asynchronously via the cron (deliverCompletedRoots), so the
        // delivery guard below must NOT fire for it — only for runs that would
        // finalize right now with nothing delivered.
        const taskRows = await db
          .select({ id: agentTasks.id })
          .from(agentTasks)
          .where(eq(agentTasks.rootJobId, jobId as string));

        // Delivery guard (mirror of the anti-spam guard): on a tool-only channel,
        // calling return_result without ever delivering — and with no task-board
        // flow to deliver later — would complete the job silently. Re-prompt the
        // agent to send via its tool first, mirroring the j-pré defer pattern.
        // Live incident: job 5d84d72e (2026-05-29).
        if (requiresToolDelivery && !telegramDelivered && taskRows.length === 0) {
          if (telegramRedeliveryNudges < MAX_TELEGRAM_REDELIVERY_NUDGES) {
            telegramRedeliveryNudges += 1;
            trace('telegram_redelivery_nudge', {
              turn,
              attempt: telegramRedeliveryNudges,
              via: 'return_result_branch',
            });
            toolResultBlocks.push({
              type: 'tool-result',
              toolCallId: returnResultCall.toolCallId,
              toolName: 'return_result',
              output: toResultOutput({
                error:
                  "deferred: tu n'as pas encore livré ta réponse via telegram_send_message — fais-le avant de terminer",
              }),
            });
            messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
            messages = [...messages, { role: 'user', content: deliveryNudge } as ModelMessage];
            continue;
          }
          trace('telegram_not_delivered', { turn, via: 'return_result_branch' });
          await failJob(db, jobId as string, 'telegram_not_delivered', runStats(), messages);
          return { status: 'failed', error: 'telegram_not_delivered' };
        }

        // Brique 33: return_result is status-only. Content delivery happens via
        // dashboard_publish, telegram_send_message, etc. — those tools already
        // wrote to agent_jobs.result (or a delivery channel) via their side-effects.
        // We pass empty finalResult; completeJob preserves existing result.
        const finalResult = '';
        toolsUsed = [...new Set([...toolsUsed, 'return_result'])];

        toolResultBlocks.push({
          type: 'tool-result',
          toolCallId: returnResultCall.toolCallId,
          toolName: 'return_result',
          output: toResultOutput({ acknowledged: true }),
        });
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];

        // If this run created tasks on the board, the workflow continues
        // asynchronously: the cron's executeReadyTasks runs each task and
        // deliverCompletedRoots compiles + finalizes the parent once all tasks
        // are done. Calling completeJob here would set completedAt and lock
        // out the cron's delivery (it gates on `completedAt IS NULL`), so the
        // user would never see the compiled task results — only the
        // orchestrator's summary. Instead, save a checkpoint and let the cron
        // own the final state. Status stays 'processing' until the cron flips
        // it to 'completed'.
        if (taskRows.length > 0) {
          trace('return_result_with_tasks', { taskCount: taskRows.length });
          await saveCheckpoint(db, jobId as string, {
            messages,
            turn,
            chainCount: job.chainCount ?? 0,
            toolsUsed,
            inputTokens,
            outputTokens,
            effectiveInputTokens,
            servedProvider,
            totalDurationMs: Date.now() - startedAt,
          });
          return { status: 'awaiting_tasks' };
        }

        trace('completeJob_call', { turn, toolsUsed, stats: runStats() });
        const completed = await completeJob(
          db,
          jobId as string,
          finalResult,
          toolsUsed,
          runStats(),
          messages,
        );
        if (!completed) {
          // The conditional terminal write lost the race — another writer (e.g. the
          // orphan reaper) already finalized this row. Do NOT claim 'completed':
          // report that the row was already handled so the caller never overrides it.
          trace('terminal_write_lost_race', { turn, writer: 'completeJob', jobId });
          return { status: 'already_handled' };
        } else {
          // Fire-and-forget Tier-1 reflection (OFF by default). MUST NOT block
          // or delay the job response — gates + throttle live inside the hook.
          // Snapshot carries the FINAL state (the in-memory `job` row is still
          // pre-completion). Only runs when completeJob won the terminal write.
          void maybeRunReflection(
            deps,
            db,
            {
              ...job,
              status: 'completed',
              turn,
              toolsUsed,
              messages,
            },
            runnerEnv,
          ).catch((e) => console.warn('[reflection]', e));
        }

        // Re-fetch agent_jobs.result so the caller (the parent in a router
        // delegation flow) receives the text written by dashboard_publish /
        // telegram_send_message side-effects earlier in this turn. Without
        // this, ExecuteJobResult.result was always '' and resumeDelegated
        // injected an empty tool-result into the parent, leaving the parent
        // orchestrator blind to what the sub-agent actually produced (and
        // forcing it to hallucinate or re-delegate until chain limit).
        const [finalRow] = await db
          .select({ result: agentJobs.result })
          .from(agentJobs)
          .where(eq(agentJobs.id, jobId as string))
          .limit(1);
        const propagatedResult = finalRow?.result ?? '';

        trace('exit_completed_via_return_result', {
          propagatedResultLen: propagatedResult.length,
        });
        return { status: 'completed', result: propagatedResult };
      }

      // k. Append tool results and continue
      if (toolResultBlocks.length > 0) {
        messages = [...messages, { role: 'tool', content: toolResultBlocks } as ModelMessage];
      }

      // k-bis. Guard 1b — no-progress detector. Signature of THIS turn's work:
      // each tool call's name + input + output, sorted+joined (order-independent).
      // If the identical signature repeats maxNoProgressRepeats turns in a row,
      // the agent is stuck (same call, same result) → fail loud. A real poll
      // changes its output (RUNNING → SUCCEEDED) before the threshold, so it
      // never trips; empty turns (no tool results) are ignored. Only reached on
      // looping turns — terminal turns (return_result/delegation) return earlier.
      const turnSignature = toolResultBlocks
        .map((b) => {
          const call = callsToProcess.find((c) => c.id === b.toolCallId);
          const input = call ? stableStringify(call.input) : '';
          const output =
            b.output.type === 'text' ? b.output.value : stableStringify(b.output.value ?? null);
          return `${b.toolName}\x00${input}\x00${output}`;
        })
        .sort()
        .join('\n');
      if (turnSignature !== '') {
        recentTurnSignatures.push(turnSignature);
        if (recentTurnSignatures.length > maxNoProgressRepeats) {
          recentTurnSignatures.shift();
        }
        if (
          recentTurnSignatures.length === maxNoProgressRepeats &&
          recentTurnSignatures.every((s) => s === turnSignature)
        ) {
          trace('no_progress_detected', { turn, repeats: recentTurnSignatures.length });
          await failJob(db, jobId as string, 'no_progress_detected', runStats(), messages);
          return { status: 'failed', error: 'no_progress_detected' };
        }
      }

      // k-ter. Guard 1d — no-delivery runaway detector. Update delivery/streak
      // counters AFTER tool results are appended (k step) and AFTER Guard 1b
      // has had its chance. This fires on genuine gathering turns only (a turn
      // that reached here made ≥1 non-delegation tool call and did NOT return
      // via return_result or delegation paths earlier in the loop).
      //
      // Delivery turn: any tool call in DELIVERY_OR_TERMINAL_TOOL_NAMES resets
      // turnsSinceDelivery. (return_result would have exited via j-bis above, so
      // only dashboard_publish / telegram_send_message can reset it here — but
      // we keep return_result in the set for correctness against future paths.)
      {
        const thisToolNames = toolResultBlocks.map((b) => b.toolName);
        const isDelivering = thisToolNames.some((n) => DELIVERY_OR_TERMINAL_TOOL_NAMES.has(n));
        if (isDelivering || thisToolNames.length === 0) {
          // Delivered or no tool calls (shouldn't reach here if no tools, but defensive).
          turnsSinceDelivery = 0;
          sameToolStreak = 0;
          lastSingleToolName = null;
        } else {
          // Gathering turn.
          turnsSinceDelivery += 1;
          // Same-tool streak: all calls this turn must be the SAME single tool.
          const uniqueNames = [...new Set(thisToolNames)];
          if (uniqueNames.length === 1 && uniqueNames[0] === lastSingleToolName) {
            sameToolStreak += 1;
          } else if (uniqueNames.length === 1) {
            sameToolStreak = 1;
            lastSingleToolName = uniqueNames[0] ?? null;
          } else {
            // Multiple distinct tools this turn — streak broken.
            sameToolStreak = 0;
            lastSingleToolName = null;
          }

          // Should we fire? Two triggers (either threshold):
          const nudgeTrigger =
            turnsSinceDelivery >= noDeliveryNudgeAt || sameToolStreak >= sameToolStreakNudgeAt;
          const nudgeCooldownPassed = turn - turnOfLastNudge >= nudgeSpacing;

          if (nudgeTrigger) {
            if (noDeliveryNudgesIssued < maxNoDeliveryNudges && nudgeCooldownPassed) {
              noDeliveryNudgesIssued += 1;
              turnOfLastNudge = turn;
              const forcingMsg =
                `[system] You have made ${turnsSinceDelivery} tool calls without delivering a result. ` +
                `You very likely already have enough to answer. STOP gathering now: call your delivery tool ` +
                `(e.g. dashboard_publish) AND return_result(status="success") in the same turn with your ` +
                `best answer from what you have. If you genuinely cannot proceed, call ` +
                `return_result(status="blocked") explaining what is missing. Do NOT call another gathering tool.`;
              messages = [...messages, { role: 'user', content: forcingMsg } as ModelMessage];
              trace('no_delivery_runaway_nudge', {
                turn,
                nudge: noDeliveryNudgesIssued,
                turnsSinceDelivery,
                sameToolStreak,
              });
            } else if (
              noDeliveryNudgesIssued >= maxNoDeliveryNudges &&
              turnsSinceDelivery > noDeliveryFailAt
            ) {
              // Nudge budget exhausted AND still gathering past the fail threshold.
              // Fail BEFORE the next LLM call so the (N+1)th gathering turn never runs.
              trace('no_delivery_runaway_fail', {
                turn,
                turnsSinceDelivery,
                sameToolStreak,
                nudgesIssued: noDeliveryNudgesIssued,
              });
              await failJob(db, jobId as string, 'no_delivery_runaway', runStats(), messages);
              return { status: 'failed', error: 'no_delivery_runaway' };
            }
          }
        }
      }

      // l. Persist the turn we just finished BEFORE the next LLM call. Without
      // this, a worker agent that runs many non-delegating turns (firecrawl +
      // save_memory + file_write + …) and then crashes on the next LLM call
      // loses ALL its progress — the outer catch's failJob doesn't touch
      // `messages`, so the dashboard shows only the user task and tools_used
      // stays empty. Live regression: job 8b66b21d (2026-05-17) lost 9 turns
      // of CMB research when turn-10 hit Retry exhausted.
      await saveCheckpoint(db, jobId as string, {
        messages,
        turn,
        chainCount: job.chainCount ?? 0,
        toolsUsed,
        inputTokens,
        outputTokens,
        effectiveInputTokens,
        totalCostUsd,
        servedProvider,
      });
    }
  } catch (err) {
    trace('catch', {
      errName: err instanceof Error ? err.name : 'unknown',
      errMsg: describeLlmError(err),
    });
    // Typed errors — error codes only (invariant 2)
    if (err instanceof ToolCallLimitExceededError) {
      await failJob(db, jobId as string, err.code, runStats(), messages);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof ChainLimitExceededError) {
      await failJob(db, jobId as string, err.code, runStats(), messages);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof DelegationDepthExceededError) {
      await failJob(db, jobId as string, err.code, runStats(), messages);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof QuotaExhaustedError) {
      await failJob(db, jobId as string, 'quota_exhausted', runStats(), messages);
      return { status: 'failed', error: 'quota_exhausted' };
    }

    // Guard 2: the whole configured provider chain (primary + fallbacks) is down.
    if (err instanceof AllProvidersFailedError) {
      await failJob(db, jobId as string, err.code, runStats(), messages);
      return { status: 'failed', error: err.code };
    }

    if (err instanceof MessageStructureError) {
      await failJob(
        db,
        jobId as string,
        `message_structure_invalid:${err.code}`,
        runStats(),
        messages,
      );
      return { status: 'failed', error: `message_structure_invalid:${err.code}` };
    }

    // AI SDK throws when the model calls a tool not in the allowed list. The
    // in-loop handler around generateText gives the model up to
    // MAX_UNAVAILABLE_TOOL_NUDGES bounded chances to self-correct first; reaching
    // here means that budget was spent (or the error surfaced past the loop), so
    // we fail loud — now with a user-facing explanation, not just the code.
    if (err instanceof Error) {
      const unavailableMatch = err.message.match(
        /Model tried to call unavailable tool ['"`]([^'"`]+)['"`]/i,
      );
      if (unavailableMatch) {
        const toolName = unavailableMatch[1] ?? 'unknown_tool';
        const code = `whitelist_violation:${toolName}`;
        await failJob(
          db,
          jobId as string,
          code,
          runStats(),
          messages,
          `L'agent a appelé à répétition un outil indisponible (${toolName}).`,
        );
        return { status: 'failed', error: code };
      }
    }

    // Invariant 3: never catch agent-specific exceptions. All errors fail loud —
    // with the REAL provider detail (B3), not the SDK's opaque generic message.
    const errorCode = describeLlmError(err);
    await failJob(db, jobId as string, errorCode, runStats(), messages);
    return { status: 'failed', error: errorCode };
  } finally {
    // Close every per-job MCP transport, whatever the loop's exit path.
    for (const close of mcpClosers) {
      await close().catch(() => {});
    }
  }
}
