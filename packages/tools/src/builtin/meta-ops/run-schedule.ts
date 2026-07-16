// meta-ops/run-schedule.ts — run_schedule meta-tool
// Fire a schedule's task NOW, on demand, without waiting for its cron time.
// Mirrors the web "Run now": insert a pending cron job for the schedule's agent;
// the runner picks it up and runs it. riskLevel 'write'.

import { z } from 'zod';
import {
  eq,
  and,
  agentSchedules,
  agentJobs,
  resolveOwnerChatId,
  resolveOwnerConversation,
} from '@nodal-agents/db';
import type { ChannelKind } from '@nodal-agents/delivery';
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
        id: agentSchedules.id,
        agentId: agentSchedules.agentId,
        task: agentSchedules.task,
        chatId: agentSchedules.chatId,
        notifyOnSuccess: agentSchedules.notifyOnSuccess,
        // B1 (notify-channel-choice): the schedule's explicit channel choice, if any.
        notifyChannel: agentSchedules.notifyChannel,
        // Manual "run now": prevRunAt is still "when did this schedule last
        // actually run" — this fire doesn't change that semantic.
        lastRun: agentSchedules.lastRun,
      })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.entityId, ctx.entityId), eq(agentSchedules.name, input.name)))
      .limit(1);

    if (!sched) return { ok: false, error: `No schedule named "${input.name}" in this workspace.` };
    if (!sched.task) return { ok: false, error: `Schedule "${input.name}" has no task to run.` };

    // Mirror the cron tick: carry a delivery target only if the schedule opted
    // into a success confirmation (else it runs silently, like a normal fire).
    // An explicit schedule.chatId wins; otherwise fall back to the bot owner's
    // 1:1 — never the agent's last-seen chat, which a group message silently
    // overwrites (see resolveOwnerChatId). A notify_channel choice resolves the
    // owner conversation ON THAT CHANNEL (channel-parametric resolveOwnerConversation)
    // instead — same rule run-schedules.ts's runScheduleTick applies.
    const resolvedChatId = sched.notifyOnSuccess
      ? sched.notifyChannel
        ? (sched.chatId ??
          (await resolveOwnerConversation(ctx.db, sched.agentId, sched.notifyChannel)))
        : (sched.chatId ?? (await resolveOwnerChatId(ctx.db, sched.agentId)) ?? null)
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
        scheduleId: sched.id,
        triggerContext: {
          type: 'cron',
          scheduleName: input.name,
          prevRunAt: sched.lastRun ? sched.lastRun.toISOString() : null,
          notifyChannel: (sched.notifyChannel as ChannelKind | null) ?? null,
        },
      })
      .returning({ id: agentJobs.id });

    if (!job) return { ok: false, error: 'Failed to queue the schedule run.' };

    return {
      ok: true,
      message: `Triggered schedule "${input.name}" — queued to run now (it starts within about a minute).`,
    };
  },
};
