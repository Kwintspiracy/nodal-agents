// planner/task-tools.ts — create_task and list_tasks tools for planner orchestrators
// These are dynamically generated per agent. Never hardcoded agent names.

import { DELEGATION_SCOPE_RULE } from '../router/delegation-scope';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from '@nodal-agents/db';
import { agentTasks, agents, agentJobs } from '@nodal-agents/db';
import { remainingDelegationHops, delegationDepthExceededMessage } from '../chain-counters';
import { validateDependencies } from './dependencies';
import { CREATE_TASK_TOOL_NAME, LIST_TASKS_TOOL_NAME } from './task-tool-names';
import { computeAgentToolNames, findUnavailableToolMentions } from '../router/tool-availability';
import { loadWorkspaceReach, describeOutsideAgent } from '../reach';
import type { AgentId, AnyDrizzleDb, ToolDefinition, TaskId, EntityId } from '../types';
import type { ToolContext } from '@nodal-agents/tools';

// ─── create_task schema ───────────────────────────────────────────────────────

const createTaskSchema = z.object({
  title: z.string().max(200).describe('Short title for this task (max 200 chars).'),
  description: z.string().max(2000).optional().describe('Detailed description of what to do.'),
  assigned_to: z
    .string()
    .describe('Handle (slug) of an agent of YOUR team, as the roster lists it.'),
  priority: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Task priority (default: medium).'),
  depends_on: z
    .array(z.string().uuid())
    .max(50)
    .optional()
    .describe(
      'Array of task IDs that must complete before this task starts. Use list_tasks to get IDs.',
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Additional context key/value pairs.'),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ─── list_tasks schema ────────────────────────────────────────────────────────

const listTasksSchema = z.object({
  status: z
    .enum(['todo', 'in_progress', 'done', 'cancelled', 'blocked'])
    .optional()
    .describe('Filter by status. Omit to list all tasks for this job.'),
});

export type ListTasksInput = z.infer<typeof listTasksSchema>;

// ─── generateTaskTools ────────────────────────────────────────────────────────

/**
 * Generate create_task and list_tasks tools for a planner orchestrator.
 *
 * These tools operate against the agent_tasks table, scoped to:
 * - entityId from the executing job context
 * - orchestratorId = the planner agent's ID
 * - rootJobId = the current job's ID (links all tasks to this run)
 *
 * The assigned_to field takes an agent slug and is resolved to an agent_id.
 * This ensures the assignment is data-driven (any slug from the entity works).
 */
export function generateTaskTools(
  orchestratorAgentId: AgentId,
  db: AnyDrizzleDb,
): [
  ToolDefinition<typeof createTaskSchema, { taskId: string; title: string; warning?: string }>,
  ToolDefinition<
    typeof listTasksSchema,
    Array<{
      id: string;
      title: string;
      status: string;
      assignedTo: string | null;
      dependsOn: string[];
    }>
  >,
] {
  // ─── create_task ─────────────────────────────────────────────────────────────
  const createTaskTool: ToolDefinition<
    typeof createTaskSchema,
    { taskId: string; title: string; warning?: string }
  > = {
    name: CREATE_TASK_TOOL_NAME,
    label: 'Create a task',
    summary:
      'Put a work task on the board and assign it to an agent. Tasks run after this job, in the order their dependencies allow.',
    description:
      'Create a WORK task in the task board and assign it to an agent. ' +
      'Tasks are executed asynchronously by the cron tick after this job completes. ' +
      'Use depends_on to chain tasks sequentially. ' +
      'DO NOT create a task whose job is to summarize the other tasks or to send the ' +
      'result back to the user (e.g. "Synthèse … → Telegram", "summarize and reply"): the ' +
      'user automatically receives a short summary of the whole run on their channel once ' +
      'the work tasks finish — a summary/deliver task is a duplicate and is forbidden. Only ' +
      'create tasks that do REAL work (research, write a file, send an email, build HTML, …). ' +
      DELEGATION_SCOPE_RULE,
    inputSchema: createTaskSchema,
    riskLevel: 'write',
    card: 'text',
    execute: async (input: CreateTaskInput, ctx: ToolContext) => {
      // The SAME depth guard as assign_* (invariant #8), before any row: a
      // task created here spawns a child one level deeper, and at the maximum
      // depth that child would be born beyond the limit (Codex review of #473,
      // pass 2).
      const [jobRow] = await db
        .select({ delegationDepth: agentJobs.delegationDepth })
        .from(agentJobs)
        .where(eq(agentJobs.id, ctx.jobId as string))
        .limit(1);
      const depth = jobRow?.delegationDepth ?? 0;
      if (remainingDelegationHops(depth) === 0) {
        throw new Error(delegationDepthExceededMessage());
      }

      // Resolve assigned_to slug → agent_id, scoped to this job's entity —
      // agents.slug is unique per (entity_id, slug), NOT globally (F-6,
      // audit #2), so an unscoped lookup could match a DIFFERENT entity's
      // agent sharing the same slug, letting an orchestrator hand a task
      // to another entity's agent by guessing/reusing its slug. Not found
      // (wrong entity or typo) → no assignment, same as an unknown slug.
      //
      // Then the reach rule (#473, reach.ts): a task goes to an active agent
      // of THIS orchestrator's team, the same agents `assign_*` reaches. It
      // used to accept any agent of the workspace, so the two routes reached
      // different agents. And a slug that resolved to nothing created the
      // task UNASSIGNED, which the cron tick never picks up (execute-ready.ts
      // filters on a non-null assignee): the run froze in silence. Both are
      // now a tool error the model can act on (invariant #4).
      let assignedAgentId: string | null = null;
      if (input.assigned_to) {
        const agentRows = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.slug, input.assigned_to), eq(agents.entityId, ctx.entityId)))
          .limit(1);
        const targetId = agentRows[0]?.id;
        if (!targetId) {
          throw new Error(
            `task_board_error: there is no agent with the handle '${input.assigned_to}' in ` +
              'this workspace. Use a handle from your team roster.',
          );
        }
        const reach = await loadWorkspaceReach(orchestratorAgentId, db, { delegationDepth: depth });
        if (!reach.team.has(targetId)) {
          const out = reach.outside.find((a) => a.id === targetId);
          throw new Error(
            `task_board_error: ${out?.name ?? input.assigned_to} exists in this workspace but ` +
              `is not on your team (${out ? describeOutsideAgent(out, 'delegate') : 'no team'}). ` +
              'A task can only be assigned to an agent of your team.',
          );
        }
        assignedAgentId = targetId;
      }

      // B2 (audit#2 followup) — the brief (title/description) may name a
      // tool the target agent won't actually have (e.g. "call send_image to
      // deliver the result" for a worker with no chat to reply on — task-
      // board children never get a chat_id, hasDeliveryRecipient: false
      // below, see execute-ready.ts). Non-blocking: the task is still
      // created; this only surfaces a same-turn warning so the LLM can
      // reword the brief around the expected OUTCOME instead of a
      // tool it won't be able to call. Skipped when assigned_to didn't
      // resolve — that's a separate (unknown-slug) problem.
      let warning: string | undefined;
      if (assignedAgentId) {
        const briefText = `${input.title} ${input.description ?? ''}`;
        const availableToolNames = await computeAgentToolNames(
          assignedAgentId as AgentId,
          ctx.entityId as EntityId,
          db,
          { hasDeliveryRecipient: false },
        );
        const missing = findUnavailableToolMentions(briefText, availableToolNames);
        if (missing.length > 0) {
          warning =
            `warning: le brief mentionne l'outil '${missing[0]}' que l'agent cible ` +
            `'${input.assigned_to}' n'aura pas — prescris le résultat attendu plutôt que ` +
            `l'outil, ou retire la mention`;
        }
      }

      // Validate depends_on references exist and introduce no cycle BEFORE
      // touching the DB (C1, audit followup). Uuid arrays have no FK
      // enforcement, so a hallucinated ID, a typo, or a cyclic reference
      // would otherwise insert silently — the task (and its root job) then
      // freezes forever: never picked up by the cron tick, never marked
      // `blocked`, never reaped by the watchdog. Fail loud instead so the
      // LLM gets a clear, actionable tool error and can retry.
      const dependsOn = (input.depends_on ?? []) as TaskId[];
      const newTaskId = randomUUID() as TaskId;
      await validateDependencies(newTaskId, dependsOn, ctx.entityId as EntityId, db);

      const [task] = await db
        .insert(agentTasks)
        .values({
          id: newTaskId as string,
          entityId: ctx.entityId,
          orchestratorId: orchestratorAgentId as string,
          title: input.title,
          description: input.description ?? null,
          status: 'todo',
          priority: input.priority ?? 'medium',
          assignedAgentId: assignedAgentId ?? undefined,
          dependsOn,
          context: (input.context ?? {}) as Record<string, unknown>,
          rootJobId: ctx.jobId,
          createdByAgentId: orchestratorAgentId as string,
        })
        .returning({ id: agentTasks.id, title: agentTasks.title });

      if (!task) {
        throw new Error('task_board_error: failed to insert task');
      }

      return { taskId: task.id as TaskId, title: task.title, ...(warning ? { warning } : {}) };
    },
  };

  // ─── list_tasks ───────────────────────────────────────────────────────────────
  const listTasksTool: ToolDefinition<
    typeof listTasksSchema,
    Array<{
      id: string;
      title: string;
      status: string;
      assignedTo: string | null;
      dependsOn: string[];
    }>
  > = {
    name: LIST_TASKS_TOOL_NAME,
    label: 'List tasks',
    summary:
      'See the tasks this job put on the board, with their status and who they are assigned to.',
    // Ce que l'outil NE lit PAS est dit au modèle (#567) : le 28/09, un root à
    // qui l'on disait « arrête » l'a appelé depuis un job neuf, a lu le tableau
    // vide de CE job et a répondu « rien ne tourne » pendant qu'un délégué
    // lancé par un message précédent tournait encore.
    description:
      'List the tasks that THIS job created with create_task, and only those. ' +
      'Returns task IDs (needed for depends_on), titles, statuses, and assignments. ' +
      'It does not see work started by an earlier message, by another job, or delegated with ' +
      'assign_*: an empty list says nothing about whether anything else is running.',
    inputSchema: listTasksSchema,
    riskLevel: 'read',
    card: 'text',
    execute: async (input: ListTasksInput, ctx: ToolContext) => {
      const conditions = [
        eq(agentTasks.orchestratorId, orchestratorAgentId as string),
        eq(agentTasks.rootJobId, ctx.jobId),
      ];

      if (input.status) {
        conditions.push(eq(agentTasks.status, input.status));
      }

      const taskRows = await db
        .select({
          id: agentTasks.id,
          title: agentTasks.title,
          status: agentTasks.status,
          assignedAgentId: agentTasks.assignedAgentId,
          dependsOn: agentTasks.dependsOn,
        })
        .from(agentTasks)
        .where(and(...conditions));

      // Resolve agent IDs to slugs for readability
      const agentIds = taskRows
        .map((t) => t.assignedAgentId)
        .filter((id): id is string => id !== null);

      const agentSlugs = new Map<string, string>();
      if (agentIds.length > 0) {
        const agentRows = await db
          .select({ id: agents.id, slug: agents.slug })
          .from(agents)
          .where(inArray(agents.id, agentIds));
        for (const a of agentRows) {
          agentSlugs.set(a.id, a.slug);
        }
      }

      return taskRows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignedTo: t.assignedAgentId ? (agentSlugs.get(t.assignedAgentId) ?? null) : null,
        dependsOn: (t.dependsOn ?? []) as string[],
      }));
    },
  };

  return [createTaskTool, listTasksTool];
}
