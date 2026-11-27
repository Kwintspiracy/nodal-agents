// meta-ops/schedule-ops.ts — create_schedule / update_schedule / delete_schedule / toggle_schedule
// Lets the ROOT agent manage its own cron schedules (recurring jobs). Gated by
// the `manageSchedules` grant. Cron is validated + nextRun computed via
// cron-parser (same lib the web + runner ticker use), so an invalid expression
// fails loud instead of creating a dead schedule.

import { z } from 'zod';
import { eq, and, agentSchedules, entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { CronExpressionParser } from 'cron-parser';
import {
  resolveTimezone,
  applyScheduleChange,
  buildScheduleCron,
  describeTiming,
} from '@nodal-agents/shared';
import type { DayPattern, ScheduleChange, ScheduleState } from '@nodal-agents/shared';
import type { ToolDefinition, ToolContext } from '../../types';
import { resolveAgentId } from './link-helpers';
import { lintRoutineTask } from './routine-lint';
import { ROUTINE_RUN } from '../../job-placement';

/** Compute the next fire time for a cron expression in a timezone, or null if invalid. */
function computeNextRun(expr: string, tz: string): Date | null {
  try {
    return CronExpressionParser.parse(expr.trim(), { currentDate: new Date(), tz }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * The workspace timezone — authoritative for scheduling. Read from the entity
 * (captured at onboarding / Settings), falling back to the server's zone. The
 * agent NEVER sets the timezone: it's a system setting, so a cron is always in
 * the user's zone and the agent can't mis-convert.
 */
async function workspaceTimezone(db: AnyDrizzleDb, entityId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: entities.timezone })
    .from(entities)
    .where(eq(entities.id, entityId));
  return resolveTimezone(row?.timezone ?? null);
}

/**
 * Non-blocking routine lint (H1b): resolve the TARGET agent's real tool
 * whitelist and check the routine's task text against it, returning a
 * ready-to-append "⚠️ Routine lint: …" suffix (or '' when clean or when the
 * lint can't run). Never throws — a lint failure must never break schedule
 * creation, which is why this swallows errors from resolveAgentToolNames
 * (e.g. an unusual agent config) instead of propagating them.
 */
async function routineLintSuffix(
  ctx: Pick<ToolContext, 'resolveAgentToolNames'>,
  agentId: string,
  task: string,
): Promise<string> {
  if (!ctx.resolveAgentToolNames) return '';
  try {
    // The list of the job the lint judges: a routine run, save_routine_state
    // included (Reviewer A on #641).
    const availableTools = await ctx.resolveAgentToolNames(agentId, ROUTINE_RUN);
    const { warnings } = lintRoutineTask(task, availableTools);
    if (warnings.length === 0) return '';
    return ` ⚠️ Routine lint: ${warnings.join(' | ')}`;
  } catch (err) {
    console.error(
      `[schedule-ops] routine lint failed for agent ${agentId} (non-blocking): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return '';
  }
}

/** Resolve a schedule by name within an entity (its id, and every field a change can touch). */
async function resolveSchedule(
  db: AnyDrizzleDb,
  entityId: string,
  name: string,
): Promise<{ id: string; state: ScheduleState } | null> {
  const [row] = await db
    .select({
      id: agentSchedules.id,
      name: agentSchedules.name,
      agentId: agentSchedules.agentId,
      task: agentSchedules.task,
      cronExpr: agentSchedules.cronExpr,
      timezone: agentSchedules.timezone,
      notifyOnSuccess: agentSchedules.notifyOnSuccess,
      notifyChannel: agentSchedules.notifyChannel,
      dailyBudgetUsd: agentSchedules.dailyBudgetUsd,
    })
    .from(agentSchedules)
    .where(and(eq(agentSchedules.entityId, entityId), eq(agentSchedules.name, name)))
    .limit(1);
  if (!row) return null;
  const { id, ...state } = row;
  return { id, state };
}

// ─── create_schedule ────────────────────────────────────────────────────────

const DaysSchema = z
  .union([
    z.enum(['daily', 'weekdays', 'weekends']),
    z.array(z.number().int().min(0).max(6)).min(1),
  ])
  .optional()
  .describe(
    'Which days to run: "daily", "weekdays" (Mon-Fri), "weekends", or an array of day numbers ' +
      '0=Sun..6=Sat. When creating, the default is "daily". When updating, leave it out to keep the ' +
      "schedule's current days.",
  );

const CreateScheduleInput = z.object({
  agentSlug: z.string().min(1).describe('Slug or name of the agent the schedule fires jobs for.'),
  name: z.string().min(1).describe('Unique, human-readable name for the schedule.'),
  atTimes: z
    .array(z.string())
    .optional()
    .describe(
      'Wall-clock times as "HH:MM" (24h) — e.g. ["09:00","13:00","21:00"]. The tool builds the ' +
        "schedule in the user's timezone; you give the hours the user states (no cron, no UTC). " +
        'Use this for fixed times of day.',
    ),
  everyMinutes: z
    .number()
    .int()
    .optional()
    .describe(
      'For interval schedules: run every N minutes (e.g. 15, 30, 60, 120). Use instead of atTimes.',
    ),
  days: DaysSchema,
  task: z.string().min(1).describe('The task/instructions the agent runs each time it fires.'),
  notifyOnSuccess: z
    .boolean()
    .optional()
    .describe(
      'If true, the agent confirms to the user on success (default false = runs silently).',
    ),
  dailyBudgetUsd: z
    .number()
    .min(0.5)
    .max(100)
    .optional()
    .describe(
      "Daily cost ceiling in USD for this schedule (default 5). Once the sum of a day's runs " +
        'hits it, further fires are held until the next day.',
    ),
});

type ScheduleOutput = { ok: true; message: string } | { ok: false; error: string };

export const createScheduleTool: ToolDefinition<typeof CreateScheduleInput, ScheduleOutput> = {
  name: 'create_schedule',
  label: 'Create a schedule',
  summary:
    'Set up a recurring task for an agent, at clock times or on an interval, in your own timezone.',
  description:
    'Create a recurring schedule that fires a task for an agent. Give the WHEN as either ' +
    'atTimes (fixed clock times like ["09:00","21:00"]) OR everyMinutes (an interval). You give ' +
    "wall-clock hours in the user's own timezone — the system owns the timezone, so you never write " +
    'cron or convert to UTC (that was the #1 cause of wrong schedules). Use days ' +
    '("daily"/"weekdays"/"weekends"/[0-6]) to limit which days. Fails if the agent is not found, ' +
    'or if a schedule with this name already exists in this workspace — use update_schedule to ' +
    'change an existing one instead of recreating it.',
  inputSchema: CreateScheduleInput,
  riskLevel: 'write',
  egress: 'none',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const agentId = await resolveAgentId(ctx.db, ctx.entityId, input.agentSlug);
    if (!agentId)
      return { ok: false, error: `Agent "${input.agentSlug}" not found in this workspace.` };

    // Idempotence guard (P0-S1, 2026-07-22 incident): schedule names are the
    // natural unique key within an entity (resolveSchedule/update_schedule/
    // toggle_schedule all address a schedule by entity + name). Fail loud on
    // a repeat name instead of silently inserting a second, competing
    // schedule for the same agent+task.
    const existingSchedule = await resolveSchedule(ctx.db, ctx.entityId, input.name);
    if (existingSchedule) {
      return {
        ok: false,
        error:
          `A schedule named "${input.name}" already exists in this workspace. ` +
          'Use update_schedule to change it, or toggle_schedule to pause/resume it — do not ' +
          'call create_schedule again with the same name.',
      };
    }
    // Timezone is a SYSTEM setting (workspace), never agent-provided.
    const tz = await workspaceTimezone(ctx.db, ctx.entityId);

    // Resolve the cron from atTimes XOR everyMinutes — the agent never writes cron.
    const hasTimes = input.atTimes && input.atTimes.length > 0;
    const hasInterval = input.everyMinutes !== undefined;
    if (hasTimes && hasInterval) {
      return { ok: false, error: 'Provide either atTimes OR everyMinutes, not both.' };
    }
    if (!hasTimes && !hasInterval) {
      return {
        ok: false,
        error: 'Provide atTimes (e.g. ["09:00","21:00"]) or everyMinutes (e.g. 30).',
      };
    }
    const built = buildScheduleCron({
      ...(hasTimes ? { atTimes: input.atTimes } : { everyMinutes: input.everyMinutes }),
      ...(input.days !== undefined ? { days: input.days } : {}),
    });
    if ('error' in built) return { ok: false, error: built.error };
    const cronExpr = built.cron;

    const nextRun = computeNextRun(cronExpr, tz);
    if (!nextRun) {
      return { ok: false, error: `Could not build a valid schedule. Check the times and retry.` };
    }
    await ctx.db.insert(agentSchedules).values({
      entityId: ctx.entityId,
      agentId,
      type: 'cron',
      name: input.name,
      cronExpr,
      timezone: tz,
      task: input.task,
      notifyOnSuccess: input.notifyOnSuccess ?? false,
      ...(input.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: input.dailyBudgetUsd } : {}),
      active: true,
      nextRun,
    });
    const whenLabel = hasTimes ? input.atTimes!.join(', ') : `every ${input.everyMinutes} min`;
    const lintSuffix = await routineLintSuffix(ctx, agentId, input.task);
    return {
      ok: true,
      message: `Created schedule "${input.name}" for agent "${input.agentSlug}" — runs at ${whenLabel} (${tz}). Next run: ${nextRun.toISOString()}.${lintSuffix}`,
    };
  },
};

// ─── update_schedule ────────────────────────────────────────────────────────

const UpdateScheduleInput = z.object({
  name: z.string().min(1).describe('Name of the existing schedule to edit.'),
  atTimes: z
    .array(z.string())
    .optional()
    .describe(
      'New wall-clock times as "HH:MM" — e.g. ["09:00","21:00"]. Replaces the times only: the ' +
        'days, the day of the month and the rest stay as they are.',
    ),
  everyMinutes: z
    .number()
    .int()
    .optional()
    .describe('Switch to an interval: run every N minutes. Replaces the times only.'),
  days: DaysSchema,
  task: z.string().min(1).optional().describe('New task/instructions.'),
  newName: z.string().min(1).optional().describe('Rename the schedule.'),
  notifyOnSuccess: z.boolean().optional().describe('Toggle the success notification.'),
  dailyBudgetUsd: z
    .number()
    .min(0.5)
    .max(100)
    .optional()
    .describe('New daily cost ceiling in USD for this schedule.'),
});

export const updateScheduleTool: ToolDefinition<typeof UpdateScheduleInput, ScheduleOutput> = {
  name: 'update_schedule',
  label: 'Change a schedule',
  summary: 'Change when an existing schedule runs, or its task, name, days, or notification.',
  description:
    'Edit an existing schedule. It changes ONLY what you name and keeps everything else: moving ' +
    'the times (atTimes / everyMinutes) keeps the days, the time zone, the agent and the task; ' +
    'changing the days keeps the times. Name just the part to change. You never write cron or ' +
    'convert time zones. The result states the schedule as it is after the change. A schedule ' +
    'whose timing atTimes / everyMinutes cannot express (a hand-written cron expression) is not ' +
    'rewritten: the answer says what it is and what you can change on it. Fails if no schedule ' +
    'with that name exists.',
  inputSchema: UpdateScheduleInput,
  riskLevel: 'write',
  egress: 'none',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    if (
      input.atTimes === undefined &&
      input.everyMinutes === undefined &&
      input.days === undefined &&
      input.task === undefined &&
      input.newName === undefined &&
      input.notifyOnSuccess === undefined &&
      input.dailyBudgetUsd === undefined
    ) {
      return {
        ok: false,
        error:
          'Nothing to update — provide atTimes, everyMinutes, task, newName, notifyOnSuccess, dailyBudgetUsd, or days.',
      };
    }
    const sched = await resolveSchedule(ctx.db, ctx.entityId, input.name);
    if (!sched) return { ok: false, error: `No schedule named "${input.name}" in this workspace.` };

    // What the call names, and nothing else. The time zone is the schedule's own
    // (set when it was created): an edit never reinterprets the hours it keeps.
    const change: ScheduleChange = {
      ...(input.atTimes !== undefined ? { atTimes: input.atTimes } : {}),
      ...(input.everyMinutes !== undefined ? { everyMinutes: input.everyMinutes } : {}),
      ...(input.days !== undefined ? { days: input.days as DayPattern } : {}),
      ...(input.task !== undefined ? { task: input.task } : {}),
      ...(input.newName !== undefined ? { name: input.newName } : {}),
      ...(input.notifyOnSuccess !== undefined ? { notifyOnSuccess: input.notifyOnSuccess } : {}),
      ...(input.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: input.dailyBudgetUsd } : {}),
    };
    const result = applyScheduleChange(sched.state, change);
    if (!result.ok) return { ok: false, error: result.error };

    await ctx.db
      .update(agentSchedules)
      .set({ ...result.patch, updatedAt: new Date() })
      .where(eq(agentSchedules.id, sched.id));

    const { next } = result;
    const upcoming =
      result.upcoming.length > 0
        ? ` Next runs: ${result.upcoming.map((d) => d.toISOString()).join(', ')}.`
        : '';
    return {
      ok: true,
      message:
        `Updated schedule "${next.name}" (changed: ${result.named.join(', ')}). ` +
        `It now runs ${describeTiming(next.cronExpr, next.timezone)}; ` +
        `success notification ${next.notifyOnSuccess ? 'on' : 'off'}, ` +
        `daily budget $${next.dailyBudgetUsd}.${upcoming}`,
    };
  },
};

// Note: there is intentionally NO delete_schedule — deleting is a USER action
// (dashboard only). An agent can PAUSE a schedule with toggle_schedule instead.

// ─── toggle_schedule ────────────────────────────────────────────────────────

const ToggleScheduleInput = z.object({
  name: z.string().min(1).describe('Name of the schedule to pause/resume.'),
  active: z.boolean().describe('true = resume (recomputes next run), false = pause.'),
});

export const toggleScheduleTool: ToolDefinition<typeof ToggleScheduleInput, ScheduleOutput> = {
  name: 'toggle_schedule',
  label: 'Pause or resume a schedule',
  summary: 'Pause a schedule, or start it again.',
  description:
    'Pause (active=false) or resume (active=true) a schedule. Fails if it does not exist.',
  inputSchema: ToggleScheduleInput,
  riskLevel: 'write',
  egress: 'none',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const [row] = await ctx.db
      .select({
        id: agentSchedules.id,
        cronExpr: agentSchedules.cronExpr,
        timezone: agentSchedules.timezone,
      })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.entityId, ctx.entityId), eq(agentSchedules.name, input.name)))
      .limit(1);
    if (!row) return { ok: false, error: `No schedule named "${input.name}" in this workspace.` };
    const patch: Record<string, unknown> = { active: input.active, updatedAt: new Date() };
    if (input.active) {
      const tz = row.timezone ?? (await workspaceTimezone(ctx.db, ctx.entityId));
      patch['nextRun'] = computeNextRun(row.cronExpr, tz);
    }
    await ctx.db.update(agentSchedules).set(patch).where(eq(agentSchedules.id, row.id));
    return {
      ok: true,
      message: `${input.active ? 'Resumed' : 'Paused'} schedule "${input.name}".`,
    };
  },
};
