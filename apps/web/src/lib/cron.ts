import { CronExpressionParser } from 'cron-parser';

export type CronParseResult =
  | { ok: true; nextRuns: Date[]; humanLabel: string }
  | { ok: false; error: string };

const MAX_PREVIEW = 3;

export function parseCron(expr: string, from: Date = new Date()): CronParseResult {
  if (!expr || typeof expr !== 'string') {
    return { ok: false, error: 'Empty expression' };
  }
  try {
    const interval = CronExpressionParser.parse(expr.trim(), { currentDate: from });
    const nextRuns: Date[] = [];
    for (let i = 0; i < MAX_PREVIEW; i++) {
      nextRuns.push(interval.next().toDate());
    }
    return { ok: true, nextRuns, humanLabel: humanLabel(expr) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid cron expression';
    return { ok: false, error: msg };
  }
}

export function computeNextRun(expr: string, from: Date = new Date()): Date | null {
  try {
    const interval = CronExpressionParser.parse(expr.trim(), { currentDate: from });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function humanLabel(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, mon, dow] = parts;

  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every minute';
  }

  // Every N minutes: */N * * * *
  const everyNMin = m?.match(/^\*\/(\d+)$/);
  if (everyNMin && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${everyNMin[1]} minutes`;
  }

  // Hourly: 0 * * * * or M * * * *
  if (h === '*' && dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(m ?? '')) {
    return m === '0' ? 'Every hour (top of hour)' : `Every hour at :${(m ?? '').padStart(2, '0')}`;
  }

  // Daily: M H * * *
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(m ?? '') && /^\d+$/.test(h ?? '')) {
    return `Every day at ${pad(h)}:${pad(m)}`;
  }

  // Weekly: M H * * D or D1-D2 or D1,D2,...
  if (dom === '*' && mon === '*' && /^\d+$/.test(m ?? '') && /^\d+$/.test(h ?? '')) {
    const days = parseDays(dow ?? '');
    if (days) return `Every ${days} at ${pad(h)}:${pad(m)}`;
  }

  // Monthly: M H D * *
  if (
    mon === '*' &&
    dow === '*' &&
    /^\d+$/.test(m ?? '') &&
    /^\d+$/.test(h ?? '') &&
    /^\d+$/.test(dom ?? '')
  ) {
    return `Day ${dom} of every month at ${pad(h)}:${pad(m)}`;
  }

  return expr;
}

function pad(s: string | undefined): string {
  return (s ?? '').padStart(2, '0');
}

function parseDays(dow: string): string | null {
  if (dow === '*') return 'day';
  if (dow === '1-5') return 'weekday';
  if (dow === '0,6' || dow === '6,0') return 'weekend';
  if (/^\d$/.test(dow)) {
    const n = parseInt(dow, 10);
    if (n >= 0 && n <= 6) return DAY_LABELS[n] ?? null;
  }
  if (/^[0-6](,[0-6])+$/.test(dow)) {
    return dow
      .split(',')
      .map((d) => DAY_LABELS[parseInt(d, 10)])
      .filter(Boolean)
      .join(', ');
  }
  return null;
}

// ─── Builders for friendly UI ────────────────────────────────────────────────

export type FrequencyMode = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface BuildCronInput {
  mode: FrequencyMode;
  /** for `minutes` mode: 1, 5, 10, 15, 30 */
  everyMinutes?: number;
  /** HH:MM, used by hourly (only :MM matters), daily, weekly, monthly */
  time?: string;
  /** for weekly: array of day numbers 0=Sun..6=Sat */
  weekdays?: number[];
  /** for monthly: 1-31 */
  dayOfMonth?: number;
  /** for custom mode: user-typed cron expression */
  custom?: string;
}

export function buildCron(input: BuildCronInput): string {
  const time = parseTime(input.time);
  switch (input.mode) {
    case 'minutes': {
      const n = input.everyMinutes && input.everyMinutes > 0 ? input.everyMinutes : 5;
      return `*/${n} * * * *`;
    }
    case 'hourly':
      return `${time.minute} * * * *`;
    case 'daily':
      return `${time.minute} ${time.hour} * * *`;
    case 'weekly': {
      const days =
        input.weekdays && input.weekdays.length > 0 ? input.weekdays.slice().sort().join(',') : '1';
      return `${time.minute} ${time.hour} * * ${days}`;
    }
    case 'monthly': {
      const d = input.dayOfMonth && input.dayOfMonth > 0 ? input.dayOfMonth : 1;
      return `${time.minute} ${time.hour} ${d} * *`;
    }
    case 'custom':
      return (input.custom ?? '').trim();
  }
}

function parseTime(s: string | undefined): { hour: number; minute: number } {
  if (!s) return { hour: 9, minute: 0 };
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 9, minute: 0 };
  const h = Math.max(0, Math.min(23, parseInt(m[1] ?? '0', 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2] ?? '0', 10)));
  return { hour: h, minute: min };
}

/**
 * Best-effort reverse: given a cron expr, infer which builder mode produced it.
 * Falls back to 'custom' if no preset matches. Used to populate the edit form.
 */
export function detectMode(expr: string): { mode: FrequencyMode; values: BuildCronInput } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'custom', values: { mode: 'custom', custom: expr } };
  const [m, h, dom, mon, dow] = parts;

  const everyN = m?.match(/^\*\/(\d+)$/);
  if (everyN && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return {
      mode: 'minutes',
      values: { mode: 'minutes', everyMinutes: parseInt(everyN[1] ?? '5', 10) },
    };
  }
  if (h === '*' && dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(m ?? '')) {
    return {
      mode: 'hourly',
      values: { mode: 'hourly', time: `00:${pad(m)}` },
    };
  }
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(m ?? '') && /^\d+$/.test(h ?? '')) {
    return {
      mode: 'daily',
      values: { mode: 'daily', time: `${pad(h)}:${pad(m)}` },
    };
  }
  if (dom === '*' && mon === '*' && /^\d+$/.test(m ?? '') && /^\d+$/.test(h ?? '')) {
    const days = parseDayList(dow ?? '');
    if (days) {
      return {
        mode: 'weekly',
        values: { mode: 'weekly', time: `${pad(h)}:${pad(m)}`, weekdays: days },
      };
    }
  }
  if (
    mon === '*' &&
    dow === '*' &&
    /^\d+$/.test(m ?? '') &&
    /^\d+$/.test(h ?? '') &&
    /^\d+$/.test(dom ?? '')
  ) {
    return {
      mode: 'monthly',
      values: {
        mode: 'monthly',
        time: `${pad(h)}:${pad(m)}`,
        dayOfMonth: parseInt(dom ?? '1', 10),
      },
    };
  }

  return { mode: 'custom', values: { mode: 'custom', custom: expr } };
}

function parseDayList(dow: string): number[] | null {
  if (dow === '*') return [0, 1, 2, 3, 4, 5, 6];
  if (dow === '1-5') return [1, 2, 3, 4, 5];
  if (dow === '0,6' || dow === '6,0') return [0, 6];
  if (/^\d$/.test(dow)) {
    const n = parseInt(dow, 10);
    if (n >= 0 && n <= 6) return [n];
  }
  if (/^[0-6](,[0-6])+$/.test(dow)) {
    return dow.split(',').map((d) => parseInt(d, 10));
  }
  return null;
}
