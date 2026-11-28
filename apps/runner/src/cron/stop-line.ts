// cron/stop-line.ts — the line a person reads when a sweeper ends their job (#1086).
//
// The sweepers (`reclaim-jobs.ts`, `reset-orphans.ts`) end a job they find
// nobody is moving. What they know is what the row says: the status it was
// found in, and how long ago it was last updated; for a job that waited on a
// delegated one, how that one ended. Never why: a sweeper does not know that
// the service restarted, that a worker missed a start, or that a runner died.
// Telling the person a cause it does not know sent them looking for a crash
// that never happened (#1086, observed 2026-11-14).
//
// A PLATFORM line, in brackets, made of typed fields, the same nature as the
// runner's other stop lines (`timeoutStopLine`, `providerRejectionStopLine`):
// the runner does not narrate, it states the facts it holds (invariant #2).
// It becomes the failed job's result, which `failJob` sends to where the
// request was made.

/** Milliseconds as minutes and seconds, never negative. */
export function duree(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

export interface SweptJobFacts {
  /** The status the sweeper found the job in. */
  status: string;
  /** How long the row had gone without an update. */
  idleMs: number;
  /** False when no text of this run could be recovered (#491). */
  textRecovered?: boolean;
  /** How many resumes the job already had, when they are exhausted (#443). */
  resumesExhausted?: number;
  /** The tools the interrupted turn had already run, which prevent replaying it (#443). */
  sideEffects?: readonly string[];
  /** The runtime that cannot resume, when that is the reason (#443). */
  runtimeNotResumable?: string;
  /**
   * The delegated job the swept job was waiting on, as the row found it: its
   * status, or `null` when that job no longer exists.
   */
  awaitedJob?: { status: string | null };
}

/** The line the person reads when a sweeper ends their job: the facts, no cause. */
export function sweptJobStopLine(faits: SweptJobFacts): string {
  const attendu =
    faits.awaitedJob === undefined
      ? ''
      : faits.awaitedJob.status === null
        ? '; the delegated job it waited on no longer exists'
        : `; the delegated job it waited on is ${faits.awaitedJob.status}`;
  const reprises =
    faits.resumesExhausted !== undefined
      ? `; already resumed ${String(faits.resumesExhausted)} times`
      : '';
  const effets =
    faits.sideEffects && faits.sideEffects.length > 0
      ? `; not resumed, the interrupted turn had already run: ${faits.sideEffects.join(', ')}`
      : '';
  const runtime =
    faits.runtimeNotResumable !== undefined
      ? `; runtime ${faits.runtimeNotResumable} cannot resume`
      : '';
  const perte = faits.textRecovered === false ? '; no text of this run could be recovered' : '';
  return `[stopped: status ${faits.status}, not updated for ${duree(faits.idleMs)}${attendu}${reprises}${effets}${runtime}${perte}]`;
}
