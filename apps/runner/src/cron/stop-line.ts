// cron/stop-line.ts — the line a person reads when a sweeper ends their job (#1086).
//
// The sweepers (`reclaim-jobs.ts`, `reset-orphans.ts`) end a job they find
// nobody is moving. What they know is what the row says: the status it was
// found in; for a job taken from its holder, what was observed of that holder
// (#1204: which runner instance, stopped or silent since when, on the database
// clock); for a job that waited on a delegated one, how that one ended; for a
// request, how long ago it was last updated. Never why: a sweeper does not know that
// the service restarted, that a worker missed a start, or that a runner died.
// Telling the person a cause it does not know sent them looking for a crash
// that never happened (#1086, observed 2026-11-14).
//
// A PLATFORM line, in brackets, made of typed fields, the same nature as the
// runner's other stop lines (`timeoutStopLine`, `providerRejectionStopLine`):
// the runner does not narrate, it states the facts it holds (invariant #2).
// It becomes the failed job's result, which `failJob` sends to where the
// request was made.

import type { Holder } from '../job/liveness.ts';

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
  /**
   * What was observed of the runner instance that held the job, when the
   * sweeper took it from that holder (#1204). The line then says no live
   * runner holds it, and which instance, in which state, since when.
   */
  holder?: Holder;
  /** How long the row had gone without an update, on the database clock. */
  idleMs?: number;
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

/** The first eight characters of an instance identity: enough to recognise it. */
function court(id: string): string {
  return id.slice(0, 8);
}

/** What the sweeper observed of the holder, as typed fields (#1204). */
function faitDuDetenteur(holder: Holder): string {
  switch (holder.kind) {
    case 'self':
      return 'runner (this one) runs none of it';
    case 'gone':
      if (holder.id === null) return 'no holder recorded';
      switch (holder.how) {
        case 'stopped':
          return `runner ${court(holder.id)} stopped at ${holder.stoppedAt?.toISOString() ?? '?'}`;
        case 'silent':
          return `runner ${court(holder.id)} last seen at ${holder.lastSeenAt?.toISOString() ?? '?'}`;
        case 'no_record':
          return `runner ${court(holder.id)} has no instance record`;
        case 'none':
          return 'no holder recorded';
      }
      break;
    case 'alive':
    case 'undecided':
      // Never taken: `decideJob` does not return `take_from_holder` for them.
      return `runner ${court(holder.id)} last seen at ${holder.lastSeenAt.toISOString()}`;
  }
  return 'holder unknown';
}

/** The line the person reads when a sweeper ends their job: the facts, no cause. */
export function sweptJobStopLine(faits: SweptJobFacts): string {
  const tenu = faits.holder === undefined ? '' : 'no live runner holds this job — ';
  const detenteur = faits.holder === undefined ? '' : `, ${faitDuDetenteur(faits.holder)}`;
  const age = faits.idleMs === undefined ? '' : `, not updated for ${duree(faits.idleMs)}`;
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
  return `[stopped: ${tenu}status ${faits.status}${detenteur}${age}${attendu}${reprises}${effets}${runtime}${perte}]`;
}
