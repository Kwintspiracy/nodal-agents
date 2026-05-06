// router/delegate.ts — suspend parent job, create child job
// Called by the runner when it catches DelegationPendingError from an assign_* tool.

import { eq } from '@nodalai/db';
import { agentJobs, agents } from '@nodalai/db';
import { OrchestrationError } from '../errors';
import type {
  AgentId,
  EntityId,
  JobId,
  AnyDrizzleDb,
  AgentJob,
  DelegationResult,
  PendingDelegation,
  SideToolResult,
} from '../types';

// ─── handleDelegation ─────────────────────────────────────────────────────────

/**
 * Suspend the parent job and create a child job for the delegated agent.
 *
 * Steps:
 * 1. Look up the child agent by slug (not by hardcoded name)
 * 2. Create a child agent_jobs row with parent_job_id set
 * 3. Update parent status → 'awaiting_delegation'
 * 4. Write pending_delegation jsonb with toolUseId + childJobId
 *
 * @param parentJob        The parent job being suspended
 * @param childSlug        Slug of the child agent to delegate to
 * @param toolUseId        The tool_use block ID from the LLM response
 * @param taskInput        Task + optional data/chatId to pass to the child
 * @param sideToolResults  Deferred tool_results for other tool_use blocks in same response
 * @param db               Drizzle DB handle
 */
export async function handleDelegation(
  parentJob: AgentJob,
  childSlug: string,
  toolUseId: string,
  taskInput: { task: string; chatId?: string | null; data?: string },
  sideToolResults: SideToolResult[],
  db: AnyDrizzleDb,
): Promise<DelegationResult> {
  // 1. Find the child agent by slug (always DB lookup, never hardcoded)
  const childAgentRows = await db
    .select({ id: agents.id, entityId: agents.entityId, model: agents.model })
    .from(agents)
    .where(eq(agents.slug, childSlug))
    .limit(1);

  const childAgent = childAgentRows[0];
  if (!childAgent) {
    throw new OrchestrationError('child_agent_not_found', `No agent with slug: ${childSlug}`);
  }

  // Build child task — combine main task + optional data from prior steps
  const childTask = taskInput.data
    ? `${taskInput.task}\n\n---\nData from prior step:\n${taskInput.data}`
    : taskInput.task;

  // Compute delegation depth: child = parent.delegation_depth + 1
  const childDepth = (parentJob.delegationDepth ?? 0) + 1;

  // 2. Create the child job
  const [childJob] = await db
    .insert(agentJobs)
    .values({
      entityId: parentJob.entityId as string,
      agentId: childAgent.id,
      channel: 'internal',
      task: childTask,
      chatId: taskInput.chatId ?? parentJob.chatId,
      status: 'pending',
      parentJobId: parentJob.id as string,
      delegationDepth: childDepth,
      messages: [{ role: 'user', content: childTask }],
    })
    .returning();

  if (!childJob) {
    throw new OrchestrationError('task_board_error', 'Failed to create child job row');
  }

  // 3. Build pending_delegation payload.
  // toolName mirrors the assign_<slug> tool name the LLM called; resumeDelegated
  // needs it to construct an AI SDK v4 `tool-result` message part on resume.
  const toolName = `assign_${childSlug.replace(/-/g, '_')}`;
  const pendingDelegation = {
    type: 'single' as const,
    toolUseId,
    toolName,
    subJobId: childJob.id,
    ...(sideToolResults.length > 0 ? { sideToolResults } : {}),
  };

  // 4. Update parent: status → awaiting_delegation, store pending_delegation,
  //    and persist `messages` so the [user, assistant tool_call] turn-1 history
  //    isn't lost. resumeDelegated reads `messages` back from DB to append the
  //    tool-result; without persisting here, the parent re-enters executeJob
  //    seeing only the tool-result with no user input or its own tool_call,
  //    and the LLM blindly re-delegates because it has no context.
  const [updatedParent] = await db
    .update(agentJobs)
    .set({
      status: 'awaiting_delegation',
      pendingDelegation,
      messages: parentJob.messages,
      updatedAt: new Date(),
    })
    .where(eq(agentJobs.id, parentJob.id as string))
    .returning();

  if (!updatedParent) {
    throw new OrchestrationError('parent_not_found', `Parent job not found: ${parentJob.id}`);
  }

  return {
    childJobId: childJob.id as JobId,
    parentJobUpdated: {
      id: updatedParent.id as JobId,
      agentId: updatedParent.agentId as AgentId | null,
      entityId: updatedParent.entityId as EntityId | null,
      status: updatedParent.status ?? 'awaiting_delegation',
      messages: Array.isArray(updatedParent.messages) ? (updatedParent.messages as unknown[]) : [],
      pendingDelegation: updatedParent.pendingDelegation as PendingDelegation | null,
      chainCount: updatedParent.chainCount ?? 0,
      delegationDepth: updatedParent.delegationDepth ?? 0,
      parentJobId: updatedParent.parentJobId as JobId | null,
      task: updatedParent.task,
      channel: updatedParent.channel,
      chatId: updatedParent.chatId,
    },
  };
}
