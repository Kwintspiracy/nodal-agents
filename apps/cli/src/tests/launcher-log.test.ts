// launcher-log.test.ts — the launcher writes down what it saw (issue #111, point 3).
//
// On 2026-09-15 the watchdog printed DEGRADED, a child exited, and the launcher
// took the whole stack down — all of it to a terminal that was closed. The one
// process whose job is to notice left no trace in `~/.nodalai/logs/`.

import { describe, it, expect } from 'vitest';
import { formatLauncherLine } from '../lib/launcher-log.ts';

describe('formatLauncherLine @cap:installer-et-demarrer/moteur', () => {
  it('stamps a UTC instant, not a local clock time', () => {
    // The terminal prints local time for whoever is watching. This file is read
    // days later next to a Postgres log whose %m is the server's own timestamp,
    // so it has to be comparable without anyone guessing a timezone or a date.
    const line = formatLauncherLine(new Date('2026-09-15T18:50:03.250Z'), 'degraded', 'db down');
    expect(line.startsWith('2026-09-15T18:50:03.250Z degraded ')).toBe(true);
  });

  it('names the event and its cause', () => {
    expect(formatLauncherLine(new Date(0), 'child-exited', 'service=runner')).toBe(
      '1970-01-01T00:00:00.000Z child-exited service=runner\n',
    );
  });

  it('flattens a multi-line cause onto one line', () => {
    // A launcher event whose detail wraps would break `grep` into fragments and
    // make the next line look like an event of its own.
    const line = formatLauncherLine(new Date(0), 'shutdown', 'cause=runner exited\n  and web too');
    expect(line.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(line).toContain('cause=runner exited and web too');
  });

  it('ends every record with exactly one newline', () => {
    const line = formatLauncherLine(new Date(0), 'started', 'x');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.endsWith('\n\n')).toBe(false);
  });
});
