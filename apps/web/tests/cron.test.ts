/**
 * Unit tests for src/lib/cron.ts
 *
 * The CronBuilder UI builds expressions through buildCron() and round-trips
 * them with detectMode(). parseCron() drives the live preview. We assert the
 * resulting expressions parse to the dates we expect.
 */
import { describe, it, expect } from 'vitest';
import { buildCron, computeNextRun, detectMode, humanLabel, parseCron } from '../src/lib/cron.ts';

describe('buildCron', () => {
  it('every N minutes', () => {
    expect(buildCron({ mode: 'minutes', everyMinutes: 5 })).toBe('*/5 * * * *');
    expect(buildCron({ mode: 'minutes', everyMinutes: 1 })).toBe('*/1 * * * *');
    expect(buildCron({ mode: 'minutes', everyMinutes: 30 })).toBe('*/30 * * * *');
  });

  it('hourly at minute', () => {
    expect(buildCron({ mode: 'hourly', time: '00:00' })).toBe('0 * * * *');
    expect(buildCron({ mode: 'hourly', time: '00:15' })).toBe('15 * * * *');
  });

  it('daily at HH:MM', () => {
    expect(buildCron({ mode: 'daily', time: '09:00' })).toBe('0 9 * * *');
    expect(buildCron({ mode: 'daily', time: '17:30' })).toBe('30 17 * * *');
  });

  it('weekly with multiple weekdays', () => {
    expect(buildCron({ mode: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5] })).toBe(
      '0 9 * * 1,2,3,4,5',
    );
    expect(buildCron({ mode: 'weekly', time: '10:00', weekdays: [0, 6] })).toBe('0 10 * * 0,6');
  });

  it('monthly on day N', () => {
    expect(buildCron({ mode: 'monthly', time: '08:00', dayOfMonth: 1 })).toBe('0 8 1 * *');
    expect(buildCron({ mode: 'monthly', time: '12:00', dayOfMonth: 15 })).toBe('0 12 15 * *');
  });

  it('custom passes through', () => {
    expect(buildCron({ mode: 'custom', custom: '0 6 * * 1' })).toBe('0 6 * * 1');
  });

  it('clamps invalid time', () => {
    // Hour > 23 clamps; minute > 59 clamps
    expect(buildCron({ mode: 'daily', time: '99:99' })).toBe('59 23 * * *');
  });
});

describe('detectMode (round-trip)', () => {
  const cases: Array<{ expr: string; mode: string }> = [
    { expr: '*/5 * * * *', mode: 'minutes' },
    { expr: '0 * * * *', mode: 'hourly' },
    { expr: '0 9 * * *', mode: 'daily' },
    { expr: '0 9 * * 1,2,3,4,5', mode: 'weekly' },
    { expr: '0 8 1 * *', mode: 'monthly' },
    { expr: '0 0 1 1 *', mode: 'custom' }, // 4-field overlap; we treat it as custom
  ];

  for (const tc of cases) {
    it(`detects '${tc.expr}' as ${tc.mode}`, () => {
      const result = detectMode(tc.expr);
      expect(result.mode).toBe(tc.mode);
    });
  }

  it('round-trip preserves preset expressions', () => {
    const original = '*/15 * * * *';
    const detected = detectMode(original);
    const rebuilt = buildCron(detected.values);
    expect(rebuilt).toBe(original);
  });
});

describe('parseCron', () => {
  it('returns 3 next runs for a valid expression', () => {
    const result = parseCron('0 9 * * *', new Date('2026-05-06T08:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextRuns).toHaveLength(3);
    // First run should be 09:00 same day or next, monotonic increasing
    expect(result.nextRuns[1]!.getTime()).toBeGreaterThan(result.nextRuns[0]!.getTime());
    expect(result.nextRuns[2]!.getTime()).toBeGreaterThan(result.nextRuns[1]!.getTime());
  });

  it('reports a clear error for nonsense', () => {
    const result = parseCron('not a cron');
    expect(result.ok).toBe(false);
  });

  it('returns error for empty input', () => {
    const result = parseCron('');
    expect(result.ok).toBe(false);
  });
});

describe('computeNextRun', () => {
  it('returns a Date for a valid expression', () => {
    const next = computeNextRun('0 * * * *', new Date('2026-05-06T08:30:00Z'));
    expect(next).toBeInstanceOf(Date);
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
  });

  it('returns null on bad expression', () => {
    expect(computeNextRun('garbage')).toBeNull();
  });
});

describe('humanLabel', () => {
  it('formats common presets readably', () => {
    expect(humanLabel('*/5 * * * *')).toBe('Every 5 minutes');
    expect(humanLabel('0 * * * *')).toBe('Every hour (top of hour)');
    expect(humanLabel('0 9 * * *')).toBe('Every day at 09:00');
    expect(humanLabel('0 9 * * 1-5')).toBe('Every weekday at 09:00');
    expect(humanLabel('0 9 * * 0,6')).toBe('Every weekend at 09:00');
    expect(humanLabel('0 8 1 * *')).toBe('Day 1 of every month at 08:00');
  });

  it('returns the raw expression for non-preset inputs', () => {
    expect(humanLabel('5 4 * * 1-3')).toBe('5 4 * * 1-3');
  });
});
