// Built-in: list_schedules
// List the cron schedules in the entity so the agent can answer "what are my
// automations?" and find a schedule's name to update / pause / run. Read-only,
// always-on (mirrors list_models / skill_view — pure read, no side effects).

import { agentSchedules, agents, eq, desc } from '@nodal-agents/db';
import { z } from 'zod';
import type { ToolDefinition } from '../types';

export const ListSchedulesInputSchema = z.object({
  agentSlug: z
    .string()
    .optional()
    .describe('Optional: only schedules for this agent (slug or name). Omit for all schedules.'),
});

export type ListSchedulesInput = z.infer<typeof ListSchedulesInputSchema>;

type ScheduleRow = {
  name: string;
  agent: string | null;
  cronExpr: string;
  timezone: string | null;
  active: boolean | null;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  task: string | null;
};

type ListSchedulesOutput = { ok: true; schedules: ScheduleRow[] } | { ok: false; error: string };

export const listSchedulesTool: ToolDefinition<
  typeof ListSchedulesInputSchema,
  ListSchedulesOutput
> = {
  name: 'list_schedules',
  description:
    'List the cron schedules (automations) in this workspace — name, agent, cron, timezone, ' +
    'active/paused, next & last run. Use it to answer "what are my schedules?" or to find a ' +
    "schedule's name before update_schedule / toggle_schedule / run_schedule.",
  inputSchema: ListSchedulesInputSchema,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    const rows = await ctx.db
      .select({
        name: agentSchedules.name,
        agentName: agents.name,
        agentSlug: agents.slug,
        cronExpr: agentSchedules.cronExpr,
        timezone: agentSchedules.timezone,
        active: agentSchedules.active,
        nextRun: agentSchedules.nextRun,
        lastRun: agentSchedules.lastRun,
        lastStatus: agentSchedules.lastStatus,
        task: agentSchedules.task,
      })
      .from(agentSchedules)
      .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
      .where(eq(agentSchedules.entityId, ctx.entityId))
      .orderBy(desc(agentSchedules.createdAt));

    const filtered = input.agentSlug
      ? rows.filter(
          (r) =>
            r.agentSlug === input.agentSlug ||
            (r.agentName ?? '').toLowerCase() === input.agentSlug!.toLowerCase(),
        )
      : rows;

    return {
      ok: true,
      schedules: filtered.map((r) => ({
        name: r.name,
        agent: r.agentName,
        cronExpr: r.cronExpr,
        timezone: r.timezone,
        active: r.active,
        nextRun: r.nextRun ? new Date(r.nextRun).toISOString() : null,
        lastRun: r.lastRun ? new Date(r.lastRun).toISOString() : null,
        lastStatus: r.lastStatus,
        task: r.task ? r.task.slice(0, 200) : null,
      })),
    };
  },
};
