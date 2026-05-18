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
 * @returns            Updated parent job row
 */
export async function resumeDelegated(
  parentJobId: JobId,
  _childJobId: JobId,
  childOutcome: DelegationOutcome,
  db: AnyDrizzleDb,
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
  const primaryOutput: ToolResultOutput =
    typeof childOutcome === 'string'
      ? { type: 'text', value: childOutcome }
      : { type: 'error-text', value: `Delegation failed: ${childOutcome.error}` };

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
