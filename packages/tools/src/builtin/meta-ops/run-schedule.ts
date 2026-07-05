// meta-ops/run-schedule.ts — run_schedule meta-tool
// Fire a schedule's task NOW, on demand, without waiting for its cron time.
// Mirrors the web "Run now": insert a pending cron job for the schedule's agent;
// the runner picks it up and runs it. riskLevel 'write'.

import { z } from 'zod';
import { eq, and, agentSchedules, agents, agentJobs } from '@nodal-agents/db';
import type { ToolDefinition } from '../../types';

const RunScheduleInput = z.object({
  name: z.string().min(1).describe('Name of the schedule to run now (see list_schedules).'),
});

type RunScheduleOutput = { ok: true; message: string } | { ok: false; error: string };

export const runScheduleTool: ToolDefinition<typeof RunScheduleInput, RunScheduleOutput> = {
  name: 'run_schedule',
  description:
    "Run a schedule's task NOW, on demand, without waiting for its cron time. " +
    'Use list_schedules to find the name. Fails if no schedule with that name exists or it has no task.',
  inputSchema: RunScheduleInput,
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const [sched] = await ctx.db
      .select({
        agentId: agentSchedules.agentId,
        task: agentSchedules.task,
        chatId: agentSchedules.chatId,
        notifyOnSuccess: agentSchedules.notifyOnSuccess,
        agentChatId: agents.lastSeenChatIdTelegram,
      })
      .from(agentSchedules)
      .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
      .where(and(eq(agentSchedules.entityId, ctx.entityId), eq(agentSchedules.name, input.name)))
      .limit(1);

    if (!sched) return { ok: false, error: `No schedule named "${input.name}" in this workspace.` };
    if (!sched.task) return { ok: false, error: `Schedule "${input.name}" has no task to run.` };

    // Mirror the cron tick: carry a delivery target only if the schedule opted
    // into a success confirmation (else it runs silently, like a normal fire).
    const resolvedChatId = sched.notifyOnSuccess
      ? (sched.chatId ?? sched.agentChatId ?? null)
      : null;

    const [job] = await ctx.db
      .insert(agentJobs)
      .values({
        entityId: ctx.entityId,
        agentId: sched.agentId,
        status: 'pending',
        channel: 'cron',
        task: sched.task,
        messages: [{ role: 'user', content: sched.task }],
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
      })
      .returning({ id: agentJobs.id });

    if (!job) return { ok: false, error: 'Failed to queue the schedule run.' };

    return {
      ok: true,
      message: `Triggered schedule "${input.name}" — queued to run now (it starts within about a minute).`,
    };
  },
};
