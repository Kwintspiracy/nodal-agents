// meta-ops/run-schedule.ts — run_schedule meta-tool
// Fire a schedule's task NOW, on demand, without waiting for its cron time.
// Mirrors the web "Run now": insert a pending cron job for the schedule's agent;
// the runner picks it up and runs it. riskLevel 'write'.

import { z } from 'zod';
import {
  eq,
  and,
  inArray,
  agentSchedules,
  agentJobs,
  resolveScheduleNotifyChat,
} from '@nodal-agents/db';
import { LIVE_JOB_STATUSES } from '@nodal-agents/shared';
import type { ChannelKind } from '@nodal-agents/delivery';
import type { ToolDefinition } from '../../types';

const RunScheduleInput = z.object({
  name: z.string().min(1).describe('Name of the schedule to run now (see list_schedules).'),
});

type RunScheduleOutput = { ok: true; message: string } | { ok: false; error: string };

export const runScheduleTool: ToolDefinition<typeof RunScheduleInput, RunScheduleOutput> = {
  name: 'run_schedule',
  label: 'Run a schedule now',
  summary: "Run a schedule's task straight away, without waiting for its next time.",
  description:
    "Run a schedule's task NOW, on demand, without waiting for its cron time. " +
    'Use list_schedules to find the name. Fails if no schedule with that name exists or it has no task.',
  inputSchema: RunScheduleInput,
  riskLevel: 'write',
  card: 'text',
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

    // Jamais deux exécutions de la MÊME routine en même temps. `runScheduleTick`
    // refuse depuis l'incident du 11/07/2026 (deux instances du même watcher en
    // parallèle) ; ce chemin-ci, le lancement manuel, ne regardait rien — une
    // routine qui poste pouvait poster deux fois, et un run qui attend une
    // approbation se faisait périmer son état par le run lancé entre-temps
    // (revue Codex, PR #47, passe 2). Refus EXPLICITE, jamais une file
    // silencieuse : l'appelant doit savoir que rien n'a été lancé.
    const [live] = await ctx.db
      .select({ id: agentJobs.id, status: agentJobs.status })
      .from(agentJobs)
      .where(
        and(eq(agentJobs.scheduleId, sched.id), inArray(agentJobs.status, [...LIVE_JOB_STATUSES])),
      )
      .limit(1);
    if (live) {
      return {
        ok: false,
        error:
          `Schedule "${input.name}" is already running (job ${live.id}, ${live.status}). ` +
          'Nothing was queued — wait for that run to finish, or cancel it first.',
      };
    }

    // Mirror the cron tick, by the SAME function (#649): a delivery target
    // only if the schedule opted into a success confirmation, with the channel
    // it was resolved on — or no channel when nothing says it (an explicit
    // chat on a schedule left on auto). Never the agent's last-seen chat.
    const notifyChat = await resolveScheduleNotifyChat(ctx.db, sched);

    const [job] = await ctx.db
      .insert(agentJobs)
      .values({
        entityId: ctx.entityId,
        agentId: sched.agentId,
        status: 'pending',
        channel: 'cron',
        task: sched.task,
        messages: [{ role: 'user', content: sched.task }],
        ...notifyChat,
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
