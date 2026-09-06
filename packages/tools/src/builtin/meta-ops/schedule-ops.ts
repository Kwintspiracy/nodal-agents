// meta-ops/schedule-ops.ts — create_schedule / update_schedule / delete_schedule / toggle_schedule
// Lets the ROOT agent manage its own cron schedules (recurring jobs). Gated by
// the `manageSchedules` grant. Cron is validated + nextRun computed via
// cron-parser (same lib the web + runner ticker use), so an invalid expression
// fails loud instead of creating a dead schedule.

import { z } from 'zod';
import { eq, and, agentSchedules, entities } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { CronExpressionParser } from 'cron-parser';
import { resolveTimezone } from '@nodal-agents/shared';
import type { ToolDefinition, ToolContext } from '../../types';
import { resolveAgentId } from './link-helpers';
import { lintRoutineTask } from './routine-lint';

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

/** Recurrence day patterns the agent can request without writing a cron field. */
type DayPattern = 'daily' | 'weekdays' | 'weekends' | number[]; // number[] = 0(Sun)..6(Sat)

/**
 * Build a 5-field cron expression from wall-clock times + an optional day pattern.
 * This is the deterministic path: the agent provides "HH:MM" clock times (in the
 * schedule's timezone) and the TOOL writes the cron, so the agent never hand-writes
 * cron hours or converts timezones (the source of the recurring 9am→cron bugs).
 * Returns { error } for malformed times.
 */
function buildCronFromTimes(
  atTimes: string[],
  days: DayPattern = 'daily',
): { cron: string } | { error: string } {
  const minutes = new Set<number>();
  const hours = new Set<number>();
  for (const t of atTimes) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return { error: `Invalid time "${t}". Use 24h "HH:MM" (e.g. "09:00", "21:30").` };
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return { error: `Invalid time "${t}". Hour 0-23, minute 0-59.` };
    hours.add(h);
    minutes.add(min);
  }
  if (hours.size === 0) return { error: 'Provide at least one time in atTimes.' };
  // Cron can't express independent (minute,hour) pairs in one field. When every
  // time shares the same minute (the common case: "9:00, 13:00, 21:00"), one cron
  // covers them all. Otherwise we'd need multiple schedules — reject loudly.
  if (minutes.size > 1) {
    return {
      error:
        'All times must share the same minute to fit one schedule (e.g. 09:00, 13:00, 21:00). ' +
        'For different minutes, create separate schedules.',
    };
  }
  const minuteField = [...minutes][0];
  const hourField = [...hours].sort((a, b) => a - b).join(',');
  return { cron: `${minuteField} ${hourField} * * ${dowFieldFor(days)}` };
}

/** Day-of-week cron field for a DayPattern. */
function dowFieldFor(days: DayPattern): string {
  if (days === 'weekdays') return '1-5';
  if (days === 'weekends') return '0,6';
  if (Array.isArray(days) && days.length > 0)
    return [...new Set(days)].sort((a, b) => a - b).join(',');
  return '*';
}

/** Build an interval cron ("every N minutes" / "every N hours") from everyMinutes. */
function buildIntervalCron(
  everyMinutes: number,
  days: DayPattern = 'daily',
): { cron: string } | { error: string } {
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 1440) {
    return { error: 'everyMinutes must be an integer between 1 and 1440 (24h).' };
  }
  const dow = dowFieldFor(days);
  if (everyMinutes < 60) return { cron: `*/${everyMinutes} * * * ${dow}` };
  if (everyMinutes % 60 === 0) return { cron: `0 */${everyMinutes / 60} * * ${dow}` };
  // Not a clean hour multiple and >= 60 — cron can't express it simply.
  return {
    error:
      'For intervals of an hour or more, use a whole number of hours (60, 120, 180…) ' +
      'or set specific times with atTimes.',
  };
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
    const availableTools = await ctx.resolveAgentToolNames(agentId);
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

/** Resolve a schedule by name within an entity. */
async function resolveSchedule(
  db: AnyDrizzleDb,
  entityId: string,
  name: string,
): Promise<{ id: string; cronExpr: string; timezone: string | null } | null> {
  const [row] = await db
    .select({
      id: agentSchedules.id,
      cronExpr: agentSchedules.cronExpr,
      timezone: agentSchedules.timezone,
    })
    .from(agentSchedules)
    .where(and(eq(agentSchedules.entityId, entityId), eq(agentSchedules.name, name)))
    .limit(1);
  return row ?? null;
}

// ─── create_schedule ────────────────────────────────────────────────────────

const DaysSchema = z
  .union([z.enum(['daily', 'weekdays', 'weekends']), z.array(z.number().int().min(0).max(6))])
  .optional()
  .describe(
    'Which days to run: "daily" (default), "weekdays" (Mon-Fri), "weekends", or an array of ' +
      'day numbers 0=Sun..6=Sat. Only used with atTimes.',
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
    const built = hasTimes
      ? buildCronFromTimes(input.atTimes!, input.days ?? 'daily')
      : buildIntervalCron(input.everyMinutes!, input.days ?? 'daily');
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
    .describe('New wall-clock times as "HH:MM" — e.g. ["09:00","21:00"]. Rebuilds the schedule.'),
  everyMinutes: z.number().int().optional().describe('Switch to an interval: run every N minutes.'),
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
  description:
    'Edit an existing schedule. Change WHEN with atTimes (["09:00","21:00"]) or everyMinutes — the ' +
    "tool rebuilds it in the user's timezone; you never write cron or convert. Also edits task / " +
    'name / notify / days. Fails if no schedule with that name exists.',
  inputSchema: UpdateScheduleInput,
  riskLevel: 'write',
  card: 'text',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    const hasTimes = input.atTimes && input.atTimes.length > 0;
    const hasInterval = input.everyMinutes !== undefined;
    if (
      !hasTimes &&
      !hasInterval &&
      !input.task &&
      !input.newName &&
      input.notifyOnSuccess === undefined &&
      !input.days &&
      input.dailyBudgetUsd === undefined
    ) {
      return {
        ok: false,
        error:
          'Nothing to update — provide atTimes, everyMinutes, task, newName, notifyOnSuccess, dailyBudgetUsd, or days.',
      };
    }
    if (hasTimes && hasInterval) {
      return { ok: false, error: 'Provide either atTimes OR everyMinutes, not both.' };
    }
    const sched = await resolveSchedule(ctx.db, ctx.entityId, input.name);
    if (!sched) return { ok: false, error: `No schedule named "${input.name}" in this workspace.` };
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    // Timezone is the workspace setting, never agent-provided.
    const tz = await workspaceTimezone(ctx.db, ctx.entityId);

    // Rebuild the cron if the timing changed (atTimes / everyMinutes / days).
    let newCron: string | null = null;
    if (hasTimes) {
      const built = buildCronFromTimes(input.atTimes!, input.days ?? 'daily');
      if ('error' in built) return { ok: false, error: built.error };
      newCron = built.cron;
    } else if (hasInterval) {
      const built = buildIntervalCron(input.everyMinutes!, input.days ?? 'daily');
      if ('error' in built) return { ok: false, error: built.error };
      newCron = built.cron;
    } else if (input.days) {
      // days-only change: rebuild from the existing times, keeping the same hours.
      const built = buildCronFromTimes(deriveTimesFromCron(sched.cronExpr), input.days);
      if ('error' in built) return { ok: false, error: built.error };
      newCron = built.cron;
    }
    if (newCron) {
      const nextRun = computeNextRun(newCron, tz);
      if (!nextRun)
        return { ok: false, error: `Could not build a valid schedule. Check the times.` };
      patch['cronExpr'] = newCron;
      patch['timezone'] = tz;
      patch['nextRun'] = nextRun;
    }
    if (input.task) patch['task'] = input.task;
    if (input.newName) patch['name'] = input.newName;
    if (input.notifyOnSuccess !== undefined) patch['notifyOnSuccess'] = input.notifyOnSuccess;
    if (input.dailyBudgetUsd !== undefined) patch['dailyBudgetUsd'] = input.dailyBudgetUsd;
    await ctx.db.update(agentSchedules).set(patch).where(eq(agentSchedules.id, sched.id));
    return { ok: true, message: `Updated schedule "${input.name}".` };
  },
};

/**
 * Recover "HH:MM" times from an existing cron (minute + comma hours) so a
 * `days`-only update can rebuild the cron without losing the times. Falls back
 * to the raw fields if the cron isn't the simple shape buildCronFromTimes makes.
 */
function deriveTimesFromCron(cron: string): string[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [];
  const min = parts[0]!.padStart(2, '0');
  return parts[1]!.split(',').map((h) => `${h.padStart(2, '0')}:${min}`);
}

// Note: there is intentionally NO delete_schedule — deleting is a USER action
// (dashboard only). An agent can PAUSE a schedule with toggle_schedule instead.

// ─── toggle_schedule ────────────────────────────────────────────────────────

const ToggleScheduleInput = z.object({
  name: z.string().min(1).describe('Name of the schedule to pause/resume.'),
  active: z.boolean().describe('true = resume (recomputes next run), false = pause.'),
});

export const toggleScheduleTool: ToolDefinition<typeof ToggleScheduleInput, ScheduleOutput> = {
  name: 'toggle_schedule',
  description:
    'Pause (active=false) or resume (active=true) a schedule. Fails if it does not exist.',
  inputSchema: ToggleScheduleInput,
  riskLevel: 'write',
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
