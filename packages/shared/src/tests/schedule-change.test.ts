// schedule-change.test.ts — applyScheduleChange: a change names what it changes and
// keeps everything else, whatever the way the schedule was created.
// Asserts on the computed schedule (cron, zone, every other field, next fires),
// never on call counts.

import { describe, it, expect } from 'vitest';
import {
  applyScheduleChange,
  buildScheduleCron,
  describeTiming,
  readClock,
  splitCron,
  type ScheduleState,
} from '../schedule-change';
import { BASE_SCHEDULE, SCHEDULE_CHANGE_CASES } from './schedule-change-cases';

// Friday 2026-11-27 12:00 UTC (13:00 in Paris).
const NOW = new Date('2026-11-27T12:00:00Z');
const AGENT = 'agent-1';

function storedFrom(c: { cronExpr: string; timezone: string | null }): ScheduleState {
  return { ...BASE_SCHEDULE, agentId: AGENT, cronExpr: c.cronExpr, timezone: c.timezone };
}

describe('applyScheduleChange @cap:planifier-une-tache/moteur', () => {
  describe.each(SCHEDULE_CHANGE_CASES.map((c) => [c.title, c] as const))('%s', (_title, c) => {
    const stored = storedFrom(c.stored);
    const result = applyScheduleChange(stored, c.change, NOW);

    const wanted = c.expect;
    if ('error' in wanted) {
      it('is refused and says what the schedule is', () => {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected a refusal');
        expect(result.error).toMatch(wanted.error);
      });
    } else {
      const set = wanted.set;
      it('gives the schedule as it becomes, every unnamed field kept', () => {
        if (!result.ok) throw new Error(result.error);
        expect(result.next).toEqual({ ...stored, ...set });
      });
      it('writes only what the change names (and the next run when the timing or zone is named)', () => {
        if (!result.ok) throw new Error(result.error);
        const namesTiming =
          c.change.cronExpr !== undefined ||
          c.change.atTimes !== undefined ||
          c.change.everyMinutes !== undefined ||
          c.change.days !== undefined ||
          c.change.timezone !== undefined;
        const { nextRun, ...fields } = result.patch;
        expect(Object.keys(fields).sort()).toEqual([...result.named].sort());
        for (const key of Object.keys(fields) as (keyof ScheduleState)[]) {
          expect(fields[key]).toEqual(result.next[key]);
        }
        expect(nextRun !== undefined).toBe(namesTiming);
      });
    }
  });

  it('weekdays 09:00 moved to 10:00 fires next on Monday 10:00 in the schedule zone', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      { atTimes: ['10:00'] },
      NOW,
    );
    if (!r.ok) throw new Error(r.error);
    // Friday 13:00 Paris is past 10:00: the next fires are Mon 30/11, Tue 01/12, Wed 02/12 at 10:00 Paris (09:00Z).
    expect(r.upcoming.map((d) => d.toISOString())).toEqual([
      '2026-11-30T09:00:00.000Z',
      '2026-12-01T09:00:00.000Z',
      '2026-12-02T09:00:00.000Z',
    ]);
    expect(r.patch.nextRun?.toISOString()).toBe('2026-11-30T09:00:00.000Z');
  });

  it('a rename or a new instruction never moves the next run', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      { name: 'Daily standup', task: 'Post it' },
      NOW,
    );
    if (!r.ok) throw new Error(r.error);
    expect('nextRun' in r.patch).toBe(false);
    expect(r.patch).toEqual({ name: 'Daily standup', task: 'Post it' });
  });

  it('a whole cron expression replaces the timing and keeps the rest (the dashboard form)', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      { cronExpr: ' 15 8 1 * * ' },
      NOW,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.next).toEqual({
      ...storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      cronExpr: '15 8 1 * *',
    });
  });

  it('a whole cron expression and the agent fields together are refused', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      { cronExpr: '0 10 * * *', days: 'weekdays' },
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('an invalid cron expression is refused when the timing is named', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      { cronExpr: 'not a cron' },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected a refusal');
    expect(r.error).toContain('not a cron');
  });

  it('an unknown zone is refused', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: '0 9 * * 1-5', timezone: 'Europe/Paris' }),
      { timezone: 'Mars/Olympus' },
      NOW,
    );
    expect(r.ok).toBe(false);
  });

  it('a broken stored cron does not block a rename (only naming the timing re-arms it)', () => {
    const r = applyScheduleChange(
      storedFrom({ cronExpr: 'garbage', timezone: 'Europe/Paris' }),
      { name: 'Renamed' },
      NOW,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.upcoming).toEqual([]);
    expect(r.patch).toEqual({ name: 'Renamed' });
  });
});

describe('the cron a created schedule gets @cap:planifier-une-tache/moteur', () => {
  it.each([
    [{ atTimes: ['09:00'] }, '0 9 * * *'],
    [{ atTimes: ['21:00', '09:00', '13:00'], days: 'weekdays' as const }, '0 9,13,21 * * 1-5'],
    [{ atTimes: ['09:05'], days: [6, 0] }, '5 9 * * 0,6'],
    [{ everyMinutes: 15 }, '*/15 * * * *'],
    [{ everyMinutes: 180, days: 'weekends' as const }, '0 */3 * * 0,6'],
  ])('%j -> %s', (spec, cron) => {
    expect(buildScheduleCron(spec)).toEqual({ cron });
  });

  it('what it writes reads back as the same clock', () => {
    const built = buildScheduleCron({ atTimes: ['09:00', '13:00'] });
    if ('error' in built) throw new Error(built.error);
    const f = splitCron(built.cron)!;
    expect(readClock(f.minute, f.hour)).toEqual({ kind: 'times', times: ['09:00', '13:00'] });
  });

  it('refuses what cron cannot hold', () => {
    expect('error' in buildScheduleCron({ everyMinutes: 90 })).toBe(true);
    expect('error' in buildScheduleCron({ atTimes: ['25:00'] })).toBe(true);
    expect('error' in buildScheduleCron({})).toBe(true);
    expect('error' in buildScheduleCron({ atTimes: ['09:00'], days: [] })).toBe(true);
  });
});

describe('describeTiming @cap:planifier-une-tache/moteur', () => {
  it('states times, days, zone and the cron itself', () => {
    expect(describeTiming('0 10 * * 1-5', 'Europe/Paris')).toBe(
      'at 10:00, weekdays (Mon-Fri) (Europe/Paris), cron "0 10 * * 1-5"',
    );
  });
  it('states a day of month', () => {
    expect(describeTiming('0 9 1 * *', 'Europe/Paris')).toContain('day-of-month "1"');
  });
  it('states an interval', () => {
    expect(describeTiming('*/30 * * * *', 'UTC')).toBe(
      'every 30 min, every day (UTC), cron "*/30 * * * *"',
    );
  });
  it('states a cron it cannot read as the cron itself', () => {
    expect(describeTiming('0 0 9 * * 1-5', 'UTC')).toBe(
      'the cron expression "0 0 9 * * 1-5" (UTC)',
    );
  });
});
