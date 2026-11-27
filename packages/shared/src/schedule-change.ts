// schedule-change.ts — the ONE function that computes a schedule's new state from
// its stored state plus the changes a caller names.
//
// Every writer of a schedule goes through here (the agent's update_schedule tool,
// the dashboard's edit action), whatever the way the schedule was created (the
// agent's tool, the dashboard form, a cron expression typed by hand). The rule it
// enforces: a change touches what it names and keeps everything else. A field the
// caller does not name is never defaulted, never rebuilt from other fields.
//
// Pure, no DB. Cron arithmetic is cron-parser, the same library the runner's
// ticker uses.

import { CronExpressionParser } from 'cron-parser';
import { isValidTimezone, serverTimezone } from './timezone';

/** The day patterns a caller can name without writing a cron field. */
export type DayPattern = 'daily' | 'weekdays' | 'weekends' | number[]; // number[] = 0(Sun)..6(Sat)

/** What is stored for a schedule: the fields a change can touch. */
export interface ScheduleState {
  name: string;
  agentId: string;
  task: string | null;
  cronExpr: string;
  /** IANA zone the cron is evaluated in; null = the server's zone (legacy rows). */
  timezone: string | null;
  notifyOnSuccess: boolean;
  /** null = auto. */
  notifyChannel: string | null;
  dailyBudgetUsd: number;
}

/**
 * The changes a caller names. `undefined` = not named = kept. `notifyChannel: null`
 * is a NAMED change (back to auto).
 *
 * The timing is named in ONE of two vocabularies: `cronExpr` (the whole
 * expression, as the dashboard form holds it) or any of `atTimes` / `everyMinutes`
 * / `days` (the agent's fields).
 */
export interface ScheduleChange {
  name?: string;
  agentId?: string;
  task?: string;
  timezone?: string;
  notifyOnSuccess?: boolean;
  notifyChannel?: string | null;
  dailyBudgetUsd?: number;
  cronExpr?: string;
  atTimes?: string[];
  everyMinutes?: number;
  days?: DayPattern;
}

/** The columns a change writes: only what the caller named, plus the recomputed next run. */
export type SchedulePatch = Partial<ScheduleState> & { nextRun?: Date };

export type ScheduleChangeResult =
  | {
      ok: true;
      /** The schedule as it is after the change, in full. */
      next: ScheduleState;
      /** What to write: the named fields, and `nextRun` when the timing or zone was named. */
      patch: SchedulePatch;
      /** The names of the fields the change named. */
      named: (keyof ScheduleState)[];
      /** The next fire times of `next` (up to 3), in `next`'s zone. Empty when the cron cannot be evaluated. */
      upcoming: Date[];
    }
  | { ok: false; error: string };

// ─── Reading a stored cron ───────────────────────────────────────────────────

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

/** The five fields of a cron expression, or null when it does not have exactly five. */
export function splitCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** The "when in the day" part of a cron, in the agent's own vocabulary, or 'other'. */
export type ScheduleClock =
  | { kind: 'times'; times: string[] } // "HH:MM" each, one shared minute
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'other' };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Read the minute + hour fields as what `atTimes` / `everyMinutes` would have written. */
export function readClock(minute: string, hour: string): ScheduleClock {
  if (/^\d{1,2}$/.test(minute) && /^\d{1,2}(,\d{1,2})*$/.test(hour)) {
    const m = Number(minute);
    const hours = hour.split(',').map(Number);
    if (m <= 59 && hours.every((h) => h <= 23)) {
      return { kind: 'times', times: hours.map((h) => `${pad2(h)}:${pad2(m)}`) };
    }
    return { kind: 'other' };
  }
  const everyN = /^\*\/(\d{1,2})$/.exec(minute);
  if (everyN && hour === '*') {
    const n = Number(everyN[1]);
    if (n >= 1 && n <= 59) return { kind: 'interval', everyMinutes: n };
  }
  if (minute === '0' && hour === '*') return { kind: 'interval', everyMinutes: 60 };
  const everyH = /^\*\/(\d{1,2})$/.exec(hour);
  if (minute === '0' && everyH) {
    const h = Number(everyH[1]);
    if (h >= 1 && h <= 24) return { kind: 'interval', everyMinutes: h * 60 };
  }
  return { kind: 'other' };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The day-of-week field in words, or the raw field when it has no plain wording. */
export function readDays(dayOfWeek: string): string {
  if (dayOfWeek === '*') return 'every day';
  if (dayOfWeek === '1-5') return 'weekdays (Mon-Fri)';
  if (dayOfWeek === '0,6' || dayOfWeek === '6,0') return 'weekends (Sat, Sun)';
  if (/^[0-6](,[0-6])*$/.test(dayOfWeek)) {
    return dayOfWeek
      .split(',')
      .map((d) => DAY_NAMES[Number(d)])
      .join(', ');
  }
  return `days "${dayOfWeek}"`;
}

/** A schedule's timing in words, ready to put in a tool result (what it IS, nothing hidden). */
export function describeTiming(cronExpr: string, timezone: string | null): string {
  const zone = timezone ?? serverTimezone();
  const f = splitCron(cronExpr);
  if (!f) return `the cron expression "${cronExpr}" (${zone})`;
  const clock = readClock(f.minute, f.hour);
  const when =
    clock.kind === 'times'
      ? `at ${clock.times.join(', ')}`
      : clock.kind === 'interval'
        ? `every ${clock.everyMinutes} min`
        : `on the minute/hour fields "${f.minute} ${f.hour}"`;
  const parts = [when];
  if (f.dayOfMonth !== '*') parts.push(`on day-of-month "${f.dayOfMonth}"`);
  if (f.month !== '*') parts.push(`in month "${f.month}"`);
  if (f.dayOfWeek !== '*') parts.push(readDays(f.dayOfWeek));
  else if (f.dayOfMonth === '*' && f.month === '*') parts.push('every day');
  return `${parts.join(', ')} (${zone}), cron "${cronExpr.trim()}"`;
}

// ─── Writing a cron from the agent's fields ──────────────────────────────────

/** Day-of-week cron field for a pattern, or an error for an empty list. */
function dayOfWeekFor(days: DayPattern): { field: string } | { error: string } {
  if (days === 'weekdays') return { field: '1-5' };
  if (days === 'weekends') return { field: '0,6' };
  if (days === 'daily') return { field: '*' };
  if (Array.isArray(days)) {
    if (days.length === 0) {
      return { error: 'days must name at least one day (0=Sun..6=Sat), or be "daily".' };
    }
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return { error: 'days must be whole numbers from 0 (Sun) to 6 (Sat).' };
    }
    return { field: [...new Set(days)].sort((a, b) => a - b).join(',') };
  }
  return { error: 'days must be "daily", "weekdays", "weekends" or a list of day numbers.' };
}

/** The minute and hour fields for "HH:MM" clock times that share one minute. */
function clockFieldsForTimes(
  atTimes: string[],
): { minute: string; hour: string } | { error: string } {
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
  // Cron cannot express independent (minute,hour) pairs in one field: every time
  // shares the same minute or the request needs several schedules.
  if (minutes.size > 1) {
    return {
      error:
        'All times must share the same minute to fit one schedule (e.g. 09:00, 13:00, 21:00). ' +
        'For different minutes, create separate schedules.',
    };
  }
  return {
    minute: String([...minutes][0]),
    hour: [...hours].sort((a, b) => a - b).join(','),
  };
}

/** The minute and hour fields for "every N minutes". */
function clockFieldsForInterval(
  everyMinutes: number,
): { minute: string; hour: string } | { error: string } {
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 1440) {
    return { error: 'everyMinutes must be an integer between 1 and 1440 (24h).' };
  }
  if (everyMinutes < 60) return { minute: `*/${everyMinutes}`, hour: '*' };
  if (everyMinutes % 60 === 0) return { minute: '0', hour: `*/${everyMinutes / 60}` };
  return {
    error:
      'For intervals of an hour or more, use a whole number of hours (60, 120, 180…) ' +
      'or set specific times with atTimes.',
  };
}

/**
 * A fresh cron from the agent's fields (create_schedule): the clock from `atTimes`
 * XOR `everyMinutes`, the days from `days` (default every day), day-of-month and
 * month open. Uses the same field writers as a change, so a created schedule and
 * an edited one are spelled the same way.
 */
export function buildScheduleCron(spec: {
  atTimes?: string[];
  everyMinutes?: number;
  days?: DayPattern;
}): { cron: string } | { error: string } {
  if (spec.atTimes !== undefined && spec.everyMinutes !== undefined) {
    return { error: 'Provide either atTimes OR everyMinutes, not both.' };
  }
  const clock =
    spec.atTimes !== undefined
      ? clockFieldsForTimes(spec.atTimes)
      : spec.everyMinutes !== undefined
        ? clockFieldsForInterval(spec.everyMinutes)
        : { error: 'Provide atTimes (e.g. ["09:00","21:00"]) or everyMinutes (e.g. 30).' };
  if ('error' in clock) return clock;
  const dow = dayOfWeekFor(spec.days ?? 'daily');
  if ('error' in dow) return dow;
  return { cron: `${clock.minute} ${clock.hour} * * ${dow.field}` };
}

/**
 * The cron of a schedule that is `expr`, after the agent's fields (`atTimes` /
 * `everyMinutes` / `days`) are applied to it. Only the fields a change names are
 * written; the others keep their stored text.
 *
 * - times / interval replace the minute + hour fields; day-of-month, month and
 *   day-of-week stay as stored (a monthly "0 9 1 * *" moved to 10:00 is still
 *   monthly). They are refused when the stored minute + hour fields are not
 *   something these fields can express: rewriting them would drop what the
 *   person had.
 * - days replaces the day-of-week field; minute, hour, month stay. It is refused
 *   when the stored day-of-month is restricted: cron fires on day-of-month OR
 *   day-of-week when both are set, which is not what "on weekdays" means.
 */
function applyAgentFields(
  state: ScheduleState,
  change: ScheduleChange,
): { cron: string } | { error: string } {
  const namesClock = change.atTimes !== undefined || change.everyMinutes !== undefined;
  const namesDays = change.days !== undefined;
  const fields = splitCron(state.cronExpr);

  const refuse = (why: string, canChange: string): { error: string } => ({
    error:
      `Schedule "${state.name}" is ${describeTiming(state.cronExpr, state.timezone)}, ` +
      `${why}. It was not changed. ${canChange}`,
  });

  if (!fields) {
    return refuse(
      'which does not have the five cron fields',
      'Its timing cannot be edited with atTimes / everyMinutes / days; you can still change its task, name, notification and budget, or ask the person to edit it in the dashboard.',
    );
  }
  if (namesDays && fields.dayOfMonth !== '*') {
    return refuse(
      `which is restricted to day-of-month "${fields.dayOfMonth}", so "days" cannot be added to it`,
      'You can change its times (the day of month is kept), its task, name, notification and budget.',
    );
  }
  if (namesClock && readClock(fields.minute, fields.hour).kind === 'other') {
    return refuse(
      `whose minute and hour fields ("${fields.minute} ${fields.hour}") atTimes / everyMinutes cannot express`,
      'You can change its days, its task, name, notification and budget, or ask the person to edit its timing in the dashboard.',
    );
  }

  let { minute, hour } = fields;
  if (namesClock) {
    const clock =
      change.atTimes !== undefined
        ? clockFieldsForTimes(change.atTimes)
        : clockFieldsForInterval(change.everyMinutes!);
    if ('error' in clock) return clock;
    ({ minute, hour } = clock);
  }
  let dayOfWeek = fields.dayOfWeek;
  if (namesDays) {
    const dow = dayOfWeekFor(change.days!);
    if ('error' in dow) return dow;
    dayOfWeek = dow.field;
  }
  return { cron: `${minute} ${hour} ${fields.dayOfMonth} ${fields.month} ${dayOfWeek}` };
}

// ─── The function ────────────────────────────────────────────────────────────

/** Up to `count` fire times of `cronExpr` in `timezone` (null = server zone), or an error. */
function fireTimes(
  cronExpr: string,
  timezone: string | null,
  now: Date,
  count: number,
): { times: Date[] } | { error: string } {
  try {
    const it = CronExpressionParser.parse(cronExpr.trim(), {
      currentDate: now,
      ...(timezone ? { tz: timezone } : {}),
    });
    const times: Date[] = [];
    for (let i = 0; i < count; i++) times.push(it.next().toDate());
    return { times };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const TIMING_KEYS = ['cronExpr', 'atTimes', 'everyMinutes', 'days'] as const;

/**
 * The schedule as it becomes when `change` is applied to `stored`.
 *
 * Fail loud: a change that cannot be applied without rewriting what it does not
 * name is refused with a message that says what the schedule is. Nothing is
 * rebuilt silently, nothing is defaulted.
 */
export function applyScheduleChange(
  stored: ScheduleState,
  change: ScheduleChange,
  now: Date = new Date(),
): ScheduleChangeResult {
  const named: (keyof ScheduleState)[] = [];
  const patch: SchedulePatch = {};
  const next: ScheduleState = { ...stored };

  const set = <K extends keyof ScheduleState>(key: K, value: ScheduleState[K]): void => {
    next[key] = value;
    (patch as Record<string, unknown>)[key] = value;
    named.push(key);
  };

  if (change.name !== undefined) set('name', change.name);
  if (change.agentId !== undefined) set('agentId', change.agentId);
  if (change.task !== undefined) set('task', change.task);
  if (change.notifyOnSuccess !== undefined) set('notifyOnSuccess', change.notifyOnSuccess);
  if (change.notifyChannel !== undefined) set('notifyChannel', change.notifyChannel);
  if (change.dailyBudgetUsd !== undefined) set('dailyBudgetUsd', change.dailyBudgetUsd);
  if (change.timezone !== undefined) {
    if (!isValidTimezone(change.timezone)) {
      return {
        ok: false,
        error: `Unknown time zone "${change.timezone}". Use an IANA name such as "Europe/Paris".`,
      };
    }
    set('timezone', change.timezone);
  }

  // ── timing ──
  if (change.atTimes !== undefined && change.everyMinutes !== undefined) {
    return { ok: false, error: 'Provide either atTimes OR everyMinutes, not both.' };
  }
  const namesTiming = TIMING_KEYS.some((k) => change[k] !== undefined);
  if (change.cronExpr !== undefined) {
    if (TIMING_KEYS.some((k) => k !== 'cronExpr' && change[k] !== undefined)) {
      return {
        ok: false,
        error:
          'Give the timing as a cron expression OR as atTimes / everyMinutes / days, not both.',
      };
    }
    const cron = change.cronExpr.trim();
    if (cron === '') return { ok: false, error: 'The cron expression is empty.' };
    set('cronExpr', cron);
  } else if (namesTiming) {
    const applied = applyAgentFields(stored, change);
    if ('error' in applied) return { ok: false, error: applied.error };
    set('cronExpr', applied.cron);
  }

  // The next fire is recomputed whenever the caller names the timing or the zone
  // (naming them is what re-arms a schedule); a rename or a new task never moves it.
  const rearm = namesTiming || change.timezone !== undefined;
  const fires = fireTimes(next.cronExpr, next.timezone, now, 3);
  if ('error' in fires) {
    if (rearm) {
      return { ok: false, error: `Invalid cron expression "${next.cronExpr}": ${fires.error}` };
    }
    return { ok: true, next, patch, named, upcoming: [] };
  }
  if (rearm) patch.nextRun = fires.times[0];
  return { ok: true, next, patch, named, upcoming: fires.times };
}
