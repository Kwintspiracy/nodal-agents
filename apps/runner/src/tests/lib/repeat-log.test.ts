// repeat-log.test.ts — the repeating-failure collapser.
//
// Measured motivation (a real runner.log): a Postgres outage made 17 code
// sites log the identical failure every 30s, producing 7 412 of the file's
// 61 359 lines. Rotation caps a service log at 20 MB, so a long outage evicts
// the lines that explained the cause and keeps only the consequence, repeated.
//
// The contract asserted here is deliberately narrow: never suppress the FIRST
// occurrence (invariant #4 — a failure is always visible), never suppress a
// DIFFERENT site because a neighbour is failing, and always say how many were
// hidden so the log cannot understate an outage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  logRepeatingFailure,
  reportRepeatingRecovery,
  _resetRepeatLogForTests,
  _repeatFailureCountForTests,
} from '../../lib/repeat-log.ts';

let warns: string[];
let errors: string[];

beforeEach(() => {
  _resetRepeatLogForTests();
  warns = [];
  errors = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logRepeatingFailure', () => {
  it('always logs the FIRST occurrence in full', () => {
    logRepeatingFailure('site-a', () => 'DB scan failed: connection refused');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe('DB scan failed: connection refused');
  });

  it('suppresses the repeats in between', () => {
    for (let i = 0; i < 19; i++) logRepeatingFailure('site-a', () => 'boom');

    // 19 failures, 1 line. Before this, 19 failures meant 19 lines.
    expect(warns).toHaveLength(1);
  });

  it('re-surfaces every 20th with the running total, never understating it', () => {
    for (let i = 0; i < 60; i++) logRepeatingFailure('site-a', () => 'boom');

    expect(warns).toHaveLength(4); // #1, #20, #40, #60
    expect(warns[1]).toContain('20 in total');
    expect(warns[2]).toContain('40 in total');
    expect(warns[3]).toContain('60 in total');
    // The reader must be able to tell suppression happened at all.
    expect(warns[3]).toMatch(/suppressed/i);
  });

  it('counts each SITE independently — a noisy site never mutes a quiet one', () => {
    for (let i = 0; i < 25; i++) logRepeatingFailure('noisy', () => 'noisy failing');
    logRepeatingFailure('quiet', () => 'quiet failing for the first time');

    // The quiet site's first failure is logged even though a neighbour has
    // been failing for 25 ticks.
    expect(warns.filter((w) => w.includes('quiet failing'))).toHaveLength(1);
  });

  it('does not build the message while suppressed', () => {
    const render = vi.fn(() => 'expensive');
    for (let i = 0; i < 19; i++) logRepeatingFailure('site-a', render);

    // Called once for the line actually emitted, not 19 times.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('routes to console.error when asked', () => {
    logRepeatingFailure('site-a', () => 'fatal-ish', 'error');

    expect(errors).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });
});

describe('reportRepeatingRecovery', () => {
  it('logs a recovery line naming how many failures preceded it', () => {
    for (let i = 0; i < 43; i++) logRepeatingFailure('site-a', () => 'boom');
    warns.length = 0;

    reportRepeatingRecovery('site-a', (n) => `DB scan recovered after ${n} failed attempts`);

    expect(warns).toEqual(['DB scan recovered after 43 failed attempts']);
  });

  it('stays SILENT when the site was never failing', () => {
    // Called on every healthy tick — it must not add a line per tick, which
    // would recreate the very log storm this module exists to stop.
    for (let i = 0; i < 100; i++) {
      reportRepeatingRecovery('site-a', () => 'recovered');
    }

    expect(warns).toEqual([]);
  });

  it('resets the counter, so a later outage logs its first line again', () => {
    logRepeatingFailure('site-a', () => 'boom');
    reportRepeatingRecovery('site-a', () => 'recovered');
    warns.length = 0;

    logRepeatingFailure('site-a', () => 'boom again');

    expect(warns).toEqual(['boom again']);
    expect(_repeatFailureCountForTests('site-a')).toBe(1);
  });
});

describe('bounded memory', () => {
  it('evicts oldest keys past the cap instead of growing without limit', () => {
    for (let i = 0; i < 250; i++) logRepeatingFailure(`key-${i}`, () => 'x');

    // The earliest keys were evicted; the most recent are still tracked.
    expect(_repeatFailureCountForTests('key-0')).toBe(0);
    expect(_repeatFailureCountForTests('key-249')).toBe(1);
  });
});
