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
  describeError,
  errorIdentity,
  renderError,
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
    logRepeatingFailure('site-a', 'same-identity', () => 'DB scan failed: connection refused');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe('DB scan failed: connection refused');
  });

  it('suppresses the repeats in between', () => {
    for (let i = 0; i < 19; i++) logRepeatingFailure('site-a', 'same-identity', () => 'boom');

    // 19 failures, 1 line. Before this, 19 failures meant 19 lines.
    expect(warns).toHaveLength(1);
  });

  it('re-surfaces every 20th with the running total, never understating it', () => {
    for (let i = 0; i < 60; i++) logRepeatingFailure('site-a', 'same-identity', () => 'boom');

    expect(warns).toHaveLength(4); // #1, #20, #40, #60
    expect(warns[1]).toContain('20 in total');
    expect(warns[2]).toContain('40 in total');
    expect(warns[3]).toContain('60 in total');
    // The reader must be able to tell suppression happened at all.
    expect(warns[3]).toMatch(/suppressed/i);
  });

  it('counts each SITE independently — a noisy site never mutes a quiet one', () => {
    for (let i = 0; i < 25; i++)
      logRepeatingFailure('noisy', 'same-identity', () => 'noisy failing');
    logRepeatingFailure('quiet', 'same-identity', () => 'quiet failing for the first time');

    // The quiet site's first failure is logged even though a neighbour has
    // been failing for 25 ticks.
    expect(warns.filter((w) => w.includes('quiet failing'))).toHaveLength(1);
  });

  it('does not build the message while suppressed', () => {
    const render = vi.fn(() => 'expensive');
    for (let i = 0; i < 19; i++) logRepeatingFailure('site-a', 'same-identity', render);

    // Called once for the line actually emitted, not 19 times.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('routes to console.error when asked', () => {
    logRepeatingFailure('site-a', 'same-identity', () => 'fatal-ish', 'error');

    expect(errors).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });
});

describe('reportRepeatingRecovery', () => {
  it('logs a recovery line naming how many failures preceded it', () => {
    for (let i = 0; i < 43; i++) logRepeatingFailure('site-a', 'same-identity', () => 'boom');
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
    logRepeatingFailure('site-a', 'same-identity', () => 'boom');
    reportRepeatingRecovery('site-a', () => 'recovered');
    warns.length = 0;

    logRepeatingFailure('site-a', 'same-identity', () => 'boom again');

    expect(warns).toEqual(['boom again']);
    expect(_repeatFailureCountForTests('site-a')).toBe(1);
  });
});

describe('bounded memory — the storm must not come back at the cap', () => {
  // Found by codex review on PR #42, 4th pass, and the first fix for it was
  // WRONG: with more failing sites than the cap, evicting oldest-first logs
  // every site on every pass (suppression fully defeated). Switching to LRU
  // order, or evicting in batches, measured IDENTICALLY — when every tracked
  // site is active, whatever you evict is what you are about to touch again.
  // What works is refusing new keys past the cap and aggregating them.
  it('does not grow without limit', () => {
    for (let i = 0; i < 6000; i++) logRepeatingFailure(`key-${i}`, 'x', () => 'x');

    // Early sites are tracked, late ones fell into the aggregate — either way
    // the map is bounded.
    expect(_repeatFailureCountForTests('key-0')).toBe(1);
    expect(_repeatFailureCountForTests('key-5999')).toBe(0);
  });

  it('stays quiet across repeated passes over MORE sites than the cap', () => {
    const SITES = 6000;
    const passes = 3;
    let logged = 0;
    vi.mocked(console.warn).mockImplementation(() => {
      logged++;
    });

    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < SITES; i++) logRepeatingFailure(`site-${i}`, 'down', () => 'down');
    }

    // Measured: 18 000 with oldest-first eviction (and with LRU, and with
    // batched eviction), 4 382 with the aggregate. The bound that matters is
    // that it does NOT keep growing with each pass.
    expect(logged).toBeLessThan(SITES + 500);
  });

  it('never goes silent about the sites it cannot track', () => {
    let logged = 0;
    vi.mocked(console.warn).mockImplementation(() => {
      logged++;
    });
    for (let i = 0; i < 6000; i++) logRepeatingFailure(`site-${i}`, 'down', () => 'down');
    const afterFirstPass = logged;

    // A second pass over the untracked tail still produces aggregate lines —
    // suppressed, but never zero.
    for (let i = 5000; i < 6000; i++) logRepeatingFailure(`site-${i}`, 'down', () => 'down');

    expect(logged).toBeGreaterThan(afterFirstPass);
  });
});

describe('a CHANGED failure is never hidden behind an old one', () => {
  // Found by codex review on PR #42. Suppression keyed only by call site meant
  // that when a site kept failing but the REASON changed — "connection
  // refused" becoming "password authentication failed", or a schema error —
  // the new message stayed hidden until the next 20th occurrence, and was then
  // mislabelled as "the same failure repeated". That is precisely the root
  // cause a reader is looking for, suppressed for ~10 minutes at a 30s tick.
  it('logs immediately when the failure identity changes', () => {
    for (let i = 0; i < 5; i++) {
      logRepeatingFailure('site-a', 'connection refused', () => 'DB: connection refused');
    }
    warns.length = 0;

    logRepeatingFailure('site-a', 'password authentication failed', () => 'DB: auth failed');

    expect(warns).toEqual(['DB: auth failed']);
  });

  it('restarts the count on the new failure, so its repeats collapse too', () => {
    for (let i = 0; i < 25; i++) {
      logRepeatingFailure('site-a', 'connection refused', () => 'first kind');
    }
    logRepeatingFailure('site-a', 'auth failed', () => 'second kind');
    warns.length = 0;

    // 19 more of the SECOND kind stay quiet — the counter restarted rather
    // than carrying the first kind's total forward.
    for (let i = 0; i < 18; i++) {
      logRepeatingFailure('site-a', 'auth failed', () => 'second kind');
    }
    expect(warns).toEqual([]);

    logRepeatingFailure('site-a', 'auth failed', () => 'second kind');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('20 in total');
  });

  it('still collapses an unchanged identity', () => {
    for (let i = 0; i < 19; i++) {
      logRepeatingFailure('site-a', 'connection refused', () => 'same');
    }
    expect(warns).toHaveLength(1);
  });
});

describe('the recovery line counts the WHOLE outage', () => {
  // Found by codex review on PR #42, 9th pass. Resetting the counter when the
  // error identity changes (added on the 4th pass so a changed error surfaces
  // at once) also reset what the recovery line reports: five connection
  // failures then one auth failure then success was announced as "recovered
  // after 1 failed tick". That understates an outage in the one line an
  // operator reads to size it. Two counters: a total that spans identities,
  // and a per-identity one that drives suppression.
  it('reports every consecutive failure, across a change of reason', () => {
    for (let i = 0; i < 5; i++) {
      logRepeatingFailure('site-a', 'connection refused', () => 'conn');
    }
    logRepeatingFailure('site-a', 'auth failed', () => 'auth');
    warns.length = 0;

    reportRepeatingRecovery('site-a', (n) => `recovered after ${n} failed tick(s)`);

    expect(warns).toEqual(['recovered after 6 failed tick(s)']);
  });

  it('still suppresses per identity, so the changed error is what re-surfaces', () => {
    for (let i = 0; i < 25; i++) logRepeatingFailure('site-a', 'conn', () => 'conn');
    warns.length = 0;

    // A new reason logs at once…
    logRepeatingFailure('site-a', 'auth', () => 'auth');
    expect(warns).toEqual(['auth']);

    // …and its own repeats collapse from ITS first occurrence, not from the
    // running total (which is now 27).
    for (let i = 0; i < 18; i++) logRepeatingFailure('site-a', 'auth', () => 'auth');
    expect(warns).toHaveLength(1);
    logRepeatingFailure('site-a', 'auth', () => 'auth');
    expect(warns).toHaveLength(2);
  });
});

describe('describeError — the actionable cause is never dropped', () => {
  // Found by codex review on PR #42. Drizzle wraps every query failure in a
  // DrizzleQueryError whose `message` is just the SQL; the reason lives in
  // `cause`. Reading only `message` produced the log lines actually seen on a
  // real install — "Failed query: select …" with no hint of why — and made two
  // DIFFERENT outages look identical to the collapser, so a changed database
  // failure was suppressed as a repeat.
  it('includes the nested cause', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:25443');
    const outer = new Error('Failed query: select "channel_bindings"…', { cause: inner });

    const described = describeError(outer);

    expect(described).toContain('Failed query');
    expect(described).toContain('ECONNREFUSED');
  });

  it('makes two different causes distinguishable behind the SAME query', () => {
    const query = 'Failed query: select "channel_bindings"…';
    const refused = describeError(new Error(query, { cause: new Error('ECONNREFUSED') }));
    const auth = describeError(
      new Error(query, { cause: new Error('password authentication failed') }),
    );

    // Identical outer message, different identity — which is what lets the
    // collapser surface the second failure instead of counting it as a repeat.
    expect(refused).not.toBe(auth);
  });

  it('walks a chain and stops at a sane depth', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c') }) });
    expect(describeError(deep)).toBe('a ← caused by: b ← caused by: c');
  });

  it('handles a non-Error and a bare error', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(new Error('plain'))).toBe('plain');
  });
});

describe('errorIdentity — volatile query params must not defeat suppression', () => {
  // Found by codex review on PR #42, verified against drizzle-orm 0.45.2:
  // `new DrizzleQueryError(query, params, cause)` builds its message as
  // `Failed query: <sql>\nparams: <values>`. Several cron phases compute a
  // fresh timestamp cutoff every tick, so the params — and therefore the whole
  // message — change every 30s. Using that as the identity made every
  // occurrence look new and logged it in full: the cron half of the log storm
  // survived the fix meant to stop it.
  class FakeDrizzleError extends Error {
    query: string;
    params: unknown[];
    constructor(query: string, params: unknown[], cause: Error) {
      super(`Failed query: ${query}\nparams: ${String(params)}`, { cause });
      this.query = query;
      this.params = params;
    }
  }

  const makeErr = (cutoffMs: number) =>
    new FakeDrizzleError(
      'update "agent_jobs" set "status" = $1 where "started_at" < $2',
      ['failed', new Date(cutoffMs).toISOString()],
      new Error('connect ECONNREFUSED 127.0.0.1:25443'),
    );

  it('is STABLE across ticks that only differ by a timestamp parameter', () => {
    expect(errorIdentity(makeErr(1_000))).toBe(errorIdentity(makeErr(999_000)));
  });

  it('still separates a DIFFERENT cause behind the same query', () => {
    const a = makeErr(1_000);
    const b = new FakeDrizzleError(a.query, a.params, new Error('password authentication failed'));
    expect(errorIdentity(a)).not.toBe(errorIdentity(b));
  });

  it('still separates a different QUERY behind the same cause', () => {
    const a = makeErr(1_000);
    const b = new FakeDrizzleError(
      'select 1',
      a.params,
      new Error('connect ECONNREFUSED 127.0.0.1:25443'),
    );
    expect(errorIdentity(a)).not.toBe(errorIdentity(b));
  });

  it('collapses repeats whose params change every time', () => {
    for (let tick = 0; tick < 25; tick++) {
      const err = makeErr(tick * 30_000);
      logRepeatingFailure('cron:phase', errorIdentity(err), () => describeError(err));
    }

    // 25 ticks, 2 lines (#1 and #20) — not 25.
    expect(warns).toHaveLength(2);
  });

  it('falls back to the full description for a plain error', () => {
    expect(errorIdentity(new Error('boom'))).toBe('boom');
  });
});

describe('renderError — a first failure still locates itself', () => {
  // Found by codex review on PR #42. Rendering with describeError (message
  // only) replaced `console.warn(..., err)`, which printed the stack. For a
  // novel APPLICATION error — as opposed to a database outage, where the
  // message is the whole story — the stack is what says which function threw.
  // Losing it on the very first occurrence contradicts the promise that a
  // first failure is logged in full.
  it('includes the stack of the outermost error', () => {
    const err = new Error('something broke');
    const rendered = renderError(err);

    expect(rendered).toContain('something broke');
    expect(rendered).toContain('repeat-log.test.ts'); // i.e. a real stack frame
  });

  it('appends the cause chain after the stack', () => {
    const err = new Error('outer', { cause: new Error('ECONNREFUSED') });
    const rendered = renderError(err);

    expect(rendered).toContain('outer');
    expect(rendered).toContain('ECONNREFUSED');
  });

  it('keeps the IDENTITY free of the stack, so suppression still works', () => {
    // Two throws of the same kind from different lines must still collapse.
    const a = new Error('same failure');
    const b = new Error('same failure');
    expect(describeError(a)).toBe(describeError(b));
  });

  it('handles a non-Error', () => {
    expect(renderError('boom')).toBe('boom');
  });
});
