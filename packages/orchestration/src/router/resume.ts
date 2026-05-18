// router/resume.ts — inject child result into parent and resume
// Called when a child job completes (by cron or worker completing a child job).

import { eq } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import { OrchestrationError } from '../errors';
import type { AgentId, EntityId, JobId, AnyDrizzleDb, AgentJob } from '../types';

/**
 * What the child handed back. `string` = the child's text result on success.
 * `{ error: string }` = the child failed (executor returned `{status:'failed'}`)
 * — we inject an `error-text` tool_result so the parent's LLM treats it as a
 * tool failure and can react (notify the user, try a different sub-agent,
 * `return_result{status:'blocked'}`). Without this branch the parent died
 * silently alongside the child and the user got no Telegram message back.
 */
export type DelegationOutcome = string | { error: string };

/**
 * Tool classification, identical to `OperationRiskLevel` in
 * `@nodal-agents/shared`. Re-declared locally to avoid a runtime dependency
 * from `@nodal-agents/orchestration` on the tools package (the source of
 * truth is each `ToolDefinition.riskLevel` field). Callers pass `kindOf` —
 * typically `(name) => toolRegistry.get(name)?.riskLevel` — and we treat
 * `write` and `destructive` as side-effect-bearing.
 */
export type ToolKind = 'read' | 'write' | 'destructive';

/**
 * Caller-supplied lookup from tool name to its declared riskLevel. The
 * runner wires this to `deps.toolRegistry.get(name)?.riskLevel` so any tool
 * registered globally (builtin or adapter) is classified correctly without
 * the orchestration layer hardcoding a list.
 *
 * Return `undefined` for unknown tools — `resumeDelegated` then treats them
 * as side-effect-bearing (safe default: a tool that isn't in the registry
 * shouldn't silently grant free retries on a failed child).
 */
export type ToolKindLookup = (toolName: string) => ToolKind | undefined;

function childHadWriteSideEffects(
  toolsUsed: readonly string[] | null | undefined,
  kindOf: ToolKindLookup | undefined,
): boolean {
  if (!toolsUsed || toolsUsed.length === 0) return false;
  // No lookup supplied (legacy callers, tests without registry): conservative
  // — assume the child wrote, so we still bump the cap. Burning a retry budget
  // unnecessarily is a much smaller harm than granting unbounded retries on a
  // gmail_send_email / airtable_create_records / etc. failure.
  if (!kindOf) return true;
  return toolsUsed.some((t) => {
    const kind = kindOf(t);
    // Unknown tool (registry returned undefined) → treat as write, same
    // reasoning as the no-lookup case above.
    if (kind === undefined) return true;
    return kind === 'write' || kind === 'destructive';
  });
}

// ─── resumeDelegated ──────────────────────────────────────────────────────────

/**
 * Inject the child job's result as a tool_result into the parent job's messages,
 * then set parent.status = 'pending' so the runner picks it up again.
 *
 * This implements the "parent resumes" leg of the Router delegation flow:
 *   child completes → resumeDelegated() → parent.status = 'pending' → worker resumes
 *
 * Steps:
 * 1. Load parent job — verify status is 'awaiting_delegation'
 * 2. Read pending_delegation.toolUseId
 * 3. Append tool_result block to parent.messages (text on success, error-text on failure)
 * 4. Include sideToolResults from pending_delegation (message-integrity invariant)
 * 5. Set parent.status = 'pending', clear pending_delegation
 *
 * @param parentJobId  The ID of the waiting parent job
 * @param childJobId   The ID of the completed child job (for logging/audit)
 * @param childOutcome The child's text result, OR `{error}` if the child failed
 * @param db           Drizzle DB handle
 * @param opts.kindOf  Optional lookup from tool name → riskLevel. Used by the
 *   smart-cap branch to decide whether a failed child's side effects warrant
 *   burning the retry budget. Wire to `toolRegistry.get(name)?.riskLevel` in
 *   production. Omit in tests that don't care about the cap.
 * @returns            Updated parent job row
 */
export async function resumeDelegated(
  parentJobId: JobId,
  childJobId: JobId,
  childOutcome: DelegationOutcome,
  db: AnyDrizzleDb,
  opts?: { kindOf?: ToolKindLookup },
): Promise<AgentJob> {
  // 1. Load parent
  const parentRows = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      messages: agentJobs.messages,
      pendingDelegation: agentJobs.pendingDelegation,
      agentId: agentJobs.agentId,
      entityId: agentJobs.entityId,
      chainCount: agentJobs.chainCount,
      delegationDepth: agentJobs.delegationDepth,
      failedDelegationsCount: agentJobs.failedDelegationsCount,
      parentJobId: agentJobs.parentJobId,
      task: agentJobs.task,
      channel: agentJobs.channel,
      chatId: agentJobs.chatId,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId as string))
    .limit(1);

  const parent = parentRows[0];
  if (!parent) {
    throw new OrchestrationError('parent_not_found', `Parent job not found: ${parentJobId}`);
  }

  // 2. Verify parent is waiting for delegation
  if (parent.status !== 'awaiting_delegation') {
    throw new OrchestrationError(
      'parent_wrong_status',
      `Parent job ${parentJobId} has status '${parent.status}', expected 'awaiting_delegation'`,
    );
  }

  // 3. Extract the tool_use_id we need to match
  const pending = parent.pendingDelegation as {
    toolUseId?: string;
    toolName?: string;
    subJobId?: string;
    sideToolResults?: Array<{
      type: string;
      tool_use_id: string;
      toolName?: string;
      content: string;
      is_error?: boolean;
    }>;
  } | null;

  if (!pending?.toolUseId) {
    throw new OrchestrationError(
      'missing_tool_use_id',
      `Parent job ${parentJobId} has no toolUseId in pending_delegation`,
    );
  }

  const toolUseId = pending.toolUseId;

  // toolName is required by AI SDK v4 tool-result format. It was added to
  // pending_delegation by handleDelegation; legacy rows without it are
  // unrecoverable at this layer (we can't reconstruct the assign_<slug> tool
  // name without re-querying the orchestrator's children).
  const toolName = pending.toolName;
  if (!toolName) {
    throw new OrchestrationError(
      'missing_tool_use_id',
      `Parent job ${parentJobId} has no toolName in pending_delegation (legacy row?)`,
    );
  }

  // 4. Build a tool-role message in AI SDK v6 ModelMessage format.
  // Shape: { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName,
  //          output: ToolResultOutput }, …] }
  // ToolResultOutput is a discriminated union — we use 'text' for normal child
  // results (string) and 'error-text' for the deferred-sibling markers (which
  // carry is_error=true so the LLM treats them as failures, not normal results).
  type ToolResultOutput = { type: 'text'; value: string } | { type: 'error-text'; value: string };
  const isFailure = typeof childOutcome !== 'string';

  // Smart cap: only burn the retry budget when the failed child actually
  // produced persistent side effects. A child that crashed after only reading
  // (file_list / file_read / query_memory / tavily_search) left no duplicates
  // behind, so a retry is safe and we don't want one bad attempt to lock the
  // orchestrator out of trying again. The chainCount cap (max 5) still bounds
  // the absolute number of resumes either way.
  //
  // Classification source = `ToolDefinition.riskLevel` declared by each tool
  // (builtin + adapter). The caller provides a `kindOf` callback wired to the
  // global tool registry; we never hardcode tool names here, so adding a new
  // adapter (gmail_send_email, airtable_create_records, …) automatically gets
  // the right semantics without touching orchestration.
  let childWroteSideEffects = false;
  if (isFailure) {
    const childRows = await db
      .select({ toolsUsed: agentJobs.toolsUsed })
      .from(agentJobs)
      .where(eq(agentJobs.id, childJobId as string))
      .limit(1);
    childWroteSideEffects = childHadWriteSideEffects(childRows[0]?.toolsUsed, opts?.kindOf);
  }
  const shouldBumpFailedCount = isFailure && childWroteSideEffects;
  const nextFailedCount = (parent.failedDelegationsCount ?? 0) + (shouldBumpFailedCount ? 1 : 0);

  // When this is the SECOND (or later) failed delegation on the same parent
  // we escalate the wording so the orchestrator's LLM stops retrying and
  // notifies the user instead. The hard cap (`FAILED_DELEGATIONS_CAP` in
  // execute.ts) refuses any further `assign_*` call when this counter is
  // already at the cap; the escalated message is the soft signal that gets
  // there first. Live regression: job `29981b47` retried 3 times on an
  // unstable upstream and wrote 3 versions of the same Obsidian note.
  const errorValue = isFailure
    ? nextFailedCount >= 2
      ? `Delegation failed (attempt ${nextFailedCount}): ${childOutcome.error}. DO NOT retry — notify the user via telegram_send_message and call return_result{status:'blocked'}.`
      : `Delegation failed: ${childOutcome.error}`
    : '';

  const primaryOutput: ToolResultOutput = isFailure
    ? { type: 'error-text', value: errorValue }
    : { type: 'text', value: childOutcome as string };

  const toolResultParts: Array<{
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: ToolResultOutput;
  }> = [
    {
      type: 'tool-result',
      toolCallId: toolUseId,
      toolName,
      output: primaryOutput,
    },
  ];

  // Append deferred siblings (other assign_* dropped this turn). They share the
  // message-integrity invariant: every tool_use needs a matching tool_result.
  const sideResults = pending.sideToolResults ?? [];
  for (const sr of sideResults) {
    if (!sr.toolName) {
      throw new OrchestrationError(
        'missing_tool_use_id',
        `Side tool_result for ${sr.tool_use_id} has no toolName (legacy row?)`,
      );
    }
    toolResultParts.push({
      type: 'tool-result',
      toolCallId: sr.tool_use_id,
      toolName: sr.toolName,
      output: sr.is_error
        ? { type: 'error-text', value: sr.content }
        : { type: 'text', value: sr.content },
    });
  }

  // 5. Build updated messages array
  const existingMessages = Array.isArray(parent.messages)
    ? (parent.messages as unknown[])
    : (JSON.parse(String(parent.messages ?? '[]')) as unknown[]);

  const updatedMessages = [...existingMessages, { role: 'tool', content: toolResultParts }];

  // 6. Update parent: inject messages, set status → pending, clear pending_delegation,
  // bump chain_count. Each resume from a delegation suspension counts as one
  // self-chain step — invariant 8 caps this at maxChains (5) to prevent runaway
  // orchestrators that delegate forever instead of returning a result.
  const nextChainCount = (parent.chainCount ?? 0) + 1;
  const [updated] = await db
    .update(agentJobs)
    .set({
      messages: updatedMessages,
      status: 'pending',
      pendingDelegation: null,
      chainCount: nextChainCount,
      failedDelegationsCount: nextFailedCount,
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, parentJobId as string))
    .returning();

  if (!updated) {
    throw new OrchestrationError('parent_not_found', `Failed to update parent job ${parentJobId}`);
  }

  return {
    id: updated.id as JobId,
    agentId: updated.agentId as AgentId | null,
    entityId: updated.entityId as EntityId | null,
    status: updated.status ?? 'pending',
    messages: Array.isArray(updated.messages) ? (updated.messages as unknown[]) : [],
    pendingDelegation: null,
    chainCount: updated.chainCount ?? 0,
    delegationDepth: updated.delegationDepth ?? 0,
    parentJobId: updated.parentJobId as JobId | null,
    task: updated.task,
    channel: updated.channel,
    chatId: updated.chatId,
  };
}
