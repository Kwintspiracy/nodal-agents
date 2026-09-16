// launcher-log.ts — what the launcher saw, written where it can still be read.
//
// On 2026-09-15 the stack went down twice and the only account of it lived in a
// terminal nobody was watching: the health watchdog printed DEGRADED, a child
// exited, the launcher tore everything down and said "Stopped. Goodbye!" — all
// of it to stdout. Under `--detach`, and under the dev launcher that redirects
// to `%TEMP%\nodal-dev.log`, that is a console that is gone or a file nobody
// knows the name of. `~/.nodalai/logs/` had runner.log and web.log, and no
// record at all of the process whose JOB is to notice (issue #111, point 3).
//
// So every lifecycle decision the launcher makes also lands here, one line,
// timestamped, with its cause. Deliberately tiny: no levels, no JSON, no
// rotation policy of its own beyond the size cap the service logs use. It is
// read by a human after the fact, and its whole value is that it EXISTS.
//
// Never throws. A launcher that cannot write its diary must still be able to
// shut a stack down.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR } from './config.ts';
import { rotateLogIfNeeded } from './log-rotation.ts';

export const LAUNCHER_LOG = join(LOG_DIR, 'launcher.log');

/** What happened. A closed set, so the file can be grepped rather than read. */
export type LauncherEvent =
  | 'started'
  | 'detached'
  | 'degraded'
  | 'recovered'
  | 'child-exited'
  | 'shutdown'
  | 'refused-kill';

/**
 * One line: ISO instant, event, cause.
 *
 * ISO-8601 in UTC, not `toLocaleTimeString()` — the terminal prints local time
 * for the person watching, but a file read days later next to a Postgres log
 * (whose `%m` is the server's own timestamp) has to be comparable without
 * anyone guessing a timezone or a date.
 */
export function formatLauncherLine(at: Date, event: LauncherEvent, detail: string): string {
  return `${at.toISOString()} ${event} ${detail.replace(/\s*\r?\n\s*/g, ' ').trim()}\n`;
}

/**
 * Append one line to `~/.nodalai/logs/launcher.log`.
 *
 * Rotation is checked per write rather than at boot, because the launcher that
 * writes here may run for weeks without ever restarting — the boot-time policy
 * in `log-rotation.ts` would never fire for it.
 */
export function logLauncherEvent(event: LauncherEvent, detail: string): void {
  try {
    rotateLogIfNeeded(LAUNCHER_LOG);
    appendFileSync(LAUNCHER_LOG, formatLauncherLine(new Date(), event, detail), 'utf-8');
  } catch {
    /* best-effort: never let the diary stop the shutdown it is describing */
  }
}
