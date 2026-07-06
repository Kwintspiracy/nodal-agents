// planner/task-tools.ts — create_task and list_tasks tools for planner orchestrators
// These are dynamically generated per agent. Never hardcoded agent names.

import { z } from 'zod';
import { eq, and, inArray } from '@nodal-agents/db';
import { agentTasks, agents } from '@nodal-agents/db';
import type { AgentId, AnyDrizzleDb, ToolDefinition, TaskId } from '../types';
import type { ToolContext } from '@nodal-agents/tools';

// ─── create_task schema ───────────────────────────────────────────────────────

const createTaskSchema = z.object({
  title: z.string().max(200).describe('Short title for this task (max 200 chars).'),
  description: z.string().max(2000).optional().describe('Detailed description of what to do.'),
  assigned_to: z.string().describe('Slug of the agent to assign this task to.'),
  priority: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('Task priority (default: medium).'),
  depends_on: z
    .array(z.string())
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
  ToolDefinition<typeof createTaskSchema, { taskId: string; title: string }>,
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
  const createTaskTool: ToolDefinition<typeof createTaskSchema, { taskId: string; title: string }> =
    {
      name: 'create_task',
      description:
        'Create a WORK task in the task board and assign it to an agent. ' +
        'Tasks are executed asynchronously by the cron tick after this job completes. ' +
        'Use depends_on to chain tasks sequentially. ' +
        'DO NOT create a task whose job is to summarize the other tasks or to send the ' +
        'result back to the user (e.g. "Synthèse … → Telegram", "summarize and reply"): the ' +
        'user automatically receives a short summary of the whole run on their channel once ' +
        'the work tasks finish — a summary/deliver task is a duplicate and is forbidden. Only ' +
        'create tasks that do REAL work (research, write a file, send an email, build HTML, …).',
      inputSchema: createTaskSchema,
      riskLevel: 'write',
      execute: async (input: CreateTaskInput, ctx: ToolContext) => {
        // Resolve assigned_to slug → agent_id, scoped to this job's entity —
        // agents.slug is unique per (entity_id, slug), NOT globally (F-6,
        // audit #2), so an unscoped lookup could match a DIFFERENT entity's
        // agent sharing the same slug, letting an orchestrator hand a task
        // to another entity's agent by guessing/reusing its slug. Not found
        // (wrong entity or typo) → no assignment, same as an unknown slug.
        let assignedAgentId: string | null = null;
        if (input.assigned_to) {
          const agentRows = await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.slug, input.assigned_to), eq(agents.entityId, ctx.entityId)))
            .limit(1);
          assignedAgentId = agentRows[0]?.id ?? null;
        }

        // Validate depends_on references exist (best-effort — DB FK not enforced for uuid arrays)
        const dependsOn = (input.depends_on ?? []) as string[];

        const [task] = await db
          .insert(agentTasks)
          .values({
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

        return { taskId: task.id as TaskId, title: task.title };
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
    name: 'list_tasks',
    description:
      'List tasks on the task board for this job. ' +
      'Returns task IDs (needed for depends_on), titles, statuses, and assignments.',
    inputSchema: listTasksSchema,
    riskLevel: 'read',
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
