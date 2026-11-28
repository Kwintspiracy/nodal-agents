// job/liveness.ts — what "alive" means for a job, in ONE place (#1204).
//
// WHAT WAS WRONG. Every sweeper decided that a job was dead when a timestamp
// on its row was older than a threshold on the wall clock: 150 s without a
// heartbeat (`reclaimJobsOfDeadRunners`), 5 minutes without an update
// (`resetOrphanedJobs`), 30 s / 5 minutes in `pending` (the pending recovery
// and `failStalePendingJobs`). A laptop that slept for an hour, a clock that
// was stepped, or two hosts whose clocks differ made healthy jobs look dead:
// the runner reclaimed, and killed the commands of, jobs it was still running
// in its own process. And a parent that waited for a child whose result had
// already arrived was failed as "the service restarted" instead of being
// given that result.
//
// THE RULE NOW. A job is alive while it is HELD BY A RUNNER INSTANCE THAT IS
// RUNNING:
//   - a claim records the instance that made it (`agent_jobs.claimed_by`,
//     written by `claimJob`);
//   - a job that a run of THIS process is executing (`executeJob` is in
//     flight for it) is never touched by a sweeper, whatever its age;
//   - a job held by ANOTHER instance is taken from it only once that instance
//     is shown to be gone (`judgeHolder`): it stopped cleanly, it has no
//     instance record, or it stopped beating for `silentInstanceMs` on the
//     DATABASE's clock while this instance kept beating for at least as long.
//     That last condition is what makes a sleep or a clock step harmless: an
//     observer that was itself asleep, or cut from the database, has no gap-
//     free presence to judge anyone with;
//   - "a row nobody moves" (a lost wake-up, a parent whose resume was lost)
//     is measured on THIS process's monotonic clock, between two sightings
//     of the same row (`StuckRows`): no clock step can shorten it;
//   - every sweeper asks `decideJob`, and nothing else, what to do with a
//     row; it repairs what can be repaired (a parent whose child ended is
//     given the child's result, a job whose approval was resolved resumes)
//     before it fails anything.
//
// The one duration still read on a wall clock is the age of a request that
// no runner ever claimed (`pendingAbandonMs`): it is the age of the person's
// request, a policy on stale requests rather than a liveness test, and it is
// read on one clock only, the database's (`created_at` against `now()`).

import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { eq, sql, runnerInstances } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { runnerInstanceId } from '../runner-identity.ts';
import { RUNNER_HEARTBEAT_MS } from './heartbeat.ts';

// ─── The settings ─────────────────────────────────────────────────────────────

/**
 * Every duration the sweepers decide on, one named setting each. Nothing else
 * in the runner decides that a job is dead.
 */
export const JOB_LIVENESS = {
  /**
   * Another instance whose last beat is older than this, on the database's
   * clock, while this instance has been beating without a gap for at least
   * as long, is gone. The same figure is the gap in this instance's OWN beats
   * that interrupts its presence: it judges itself by the rule it applies to
   * the others. Two beats and a margin: one late beat is not a death.
   */
  silentInstanceMs: 2 * RUNNER_HEARTBEAT_MS + 30_000,
  /**
   * A row that no run of this process is moving, seen in the same state for
   * this long on this process's monotonic clock, is stuck: its wake-up was
   * lost (a `pending` job, a parent whose child ended, a job whose approval
   * was resolved), or no run of this process holds a job it claimed.
   */
  stuckRowMs: 30_000,
  /**
   * A request that no runner ever claimed, older than this on the database's
   * clock, is abandoned rather than started: waking a request the person
   * made long ago and moved on from would surprise them.
   */
  pendingAbandonMs: 5 * 60_000,
} as const;

export type JobLivenessSettings = { readonly [K in keyof typeof JOB_LIVENESS]: number };

// ─── The runs this process is executing ───────────────────────────────────────

const enVol = new Map<string, number>();

/**
 * `executeJob` declares that this process is executing `jobId`, from before
 * the claim to after the parent's resume: the whole span in which the job's
 * row may legitimately say `processing` (or `pending`, just before the claim)
 * with nobody else to move it. Re-entrant (a resume nested in the same call,
 * a child run inline): counted. The function returned ends the declaration;
 * calling it twice does nothing.
 */
export function enterRun(jobId: string): () => void {
  enVol.set(jobId, (enVol.get(jobId) ?? 0) + 1);
  let sorti = false;
  return () => {
    if (sorti) return;
    sorti = true;
    const n = (enVol.get(jobId) ?? 1) - 1;
    if (n <= 0) enVol.delete(jobId);
    else enVol.set(jobId, n);
  };
}

/** True while a run of this process is executing this job. */
export function isRunInFlight(jobId: string): boolean {
  return enVol.has(jobId);
}

// ─── Rows nobody moves ────────────────────────────────────────────────────────

/**
 * How long this process has seen each row in the same state, on its monotonic
 * clock. A row is identified by its id and described by a SIGNATURE (status,
 * claim, last write, what it waits for): any change starts the count again.
 * One tracker per sweeper; a row absent from a sweep is forgotten.
 */
export class StuckRows {
  private readonly vus = new Map<string, { signature: string; depuis: number }>();

  /**
   * Records this sweep's sightings and returns, per row, how long it has been
   * seen unchanged — `null` on its first sighting in this state.
   */
  observe(
    rows: readonly { id: string; signature: string }[],
    now: number,
  ): Map<string, number | null> {
    const out = new Map<string, number | null>();
    const presents = new Set<string>();
    for (const r of rows) {
      presents.add(r.id);
      const vu = this.vus.get(r.id);
      if (vu && vu.signature === r.signature) {
        out.set(r.id, now - vu.depuis);
      } else {
        this.vus.set(r.id, { signature: r.signature, depuis: now });
        out.set(r.id, null);
      }
    }
    for (const id of [...this.vus.keys()]) if (!presents.has(id)) this.vus.delete(id);
    return out;
  }
}

// ─── This instance's presence ─────────────────────────────────────────────────

/** What a sweeper knows about the instance it runs in. */
export interface Presence {
  /** This instance's identity: what `claimJob` writes in `claimed_by`. */
  readonly instanceId: string;
  /** True while a run of this process is executing this job. */
  holds(jobId: string): boolean;
  /** A clock that does not jump, in milliseconds. */
  monotonicNow(): number;
  /**
   * For how long, up to `dbNow` (the database's clock), this instance has
   * been beating without a gap. 0 when it is not beating, or when its last
   * beat is too old for it to vouch for the present.
   */
  presentFor(dbNow: Date): number;
  /** The rows each sweeper has seen, on `monotonicNow`. */
  readonly stuck: {
    readonly processing: StuckRows;
    readonly waiting: StuckRows;
    readonly pending: StuckRows;
  };
}

/**
 * The beats of one instance, on the database's clock. A gap longer than
 * `silentInstanceMs`, or a clock that went back, interrupts the presence: it
 * starts again at the next beat.
 */
export class BeatRecord {
  private depuis: number | null = null;
  private dernier: number | null = null;

  constructor(private readonly toleranceMs: number = JOB_LIVENESS.silentInstanceMs) {}

  record(dbTime: Date): void {
    const t = dbTime.getTime();
    if (this.dernier === null || t < this.dernier || t - this.dernier > this.toleranceMs) {
      this.depuis = t;
    }
    this.dernier = t;
  }

  presentFor(dbNow: Date): number {
    if (this.depuis === null || this.dernier === null) return 0;
    const now = dbNow.getTime();
    if (now < this.dernier || now - this.dernier > this.toleranceMs) return 0;
    return now - this.depuis;
  }
}

/** A presence, for the process (`processPresence`) or for a test. */
export function createPresence(opts: {
  instanceId: string;
  holds: (jobId: string) => boolean;
  monotonicNow?: () => number;
  beats?: BeatRecord;
}): Presence & { readonly beats: BeatRecord } {
  const beats = opts.beats ?? new BeatRecord();
  return {
    instanceId: opts.instanceId,
    holds: opts.holds,
    monotonicNow: opts.monotonicNow ?? (() => performance.now()),
    presentFor: (dbNow) => beats.presentFor(dbNow),
    beats,
    stuck: { processing: new StuckRows(), waiting: new StuckRows(), pending: new StuckRows() },
  };
}

/** THIS process: its identity, its runs in flight, its beats. */
export const processPresence = createPresence({
  instanceId: runnerInstanceId,
  holds: isRunInFlight,
});

/**
 * One beat of this instance: its row, created if absent, gets `last_seen_at =
 * now()` on the database's clock, and the instant the database wrote is
 * recorded. Returns that instant.
 */
export async function beatInstance(
  db: AnyDrizzleDb,
  presence: Presence & { readonly beats: BeatRecord } = processPresence,
): Promise<Date> {
  const [row] = await db
    .insert(runnerInstances)
    .values({ id: presence.instanceId, host: hostname(), pid: process.pid })
    .onConflictDoUpdate({ target: runnerInstances.id, set: { lastSeenAt: sql`now()` } })
    .returning({ lastSeenAt: runnerInstances.lastSeenAt });
  if (!row) throw new Error(`runner_instance_beat_failed: no row for ${presence.instanceId}`);
  presence.beats.record(row.lastSeenAt);
  return row.lastSeenAt;
}

/**
 * Announces this instance and keeps it beating. The first beat is AWAITED and
 * a failure is thrown: an instance that is not announced cannot claim a job
 * safely, since every other instance would take its jobs for jobs of nobody
 * (invariant #4). A later beat that fails is said, never swallowed; the gap it
 * leaves interrupts this instance's presence, which only makes it slower to
 * judge the others.
 */
export async function startInstancePresence(
  db: AnyDrizzleDb,
  presence: Presence & { readonly beats: BeatRecord } = processPresence,
): Promise<{ stop: () => Promise<void> }> {
  await beatInstance(db, presence);
  const intervalle = setInterval(() => {
    void beatInstance(db, presence).catch((err: unknown) => {
      console.warn(
        `[liveness] instance=${presence.instanceId} beat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, RUNNER_HEARTBEAT_MS);
  return {
    stop: async () => {
      clearInterval(intervalle);
      // A clean stop is said: the jobs this instance still holds are then
      // reclaimable at once, by the next instance or by another one.
      await db
        .update(runnerInstances)
        .set({ stoppedAt: sql`now()` })
        .where(eq(runnerInstances.id, presence.instanceId));
    },
  };
}

// ─── Who holds a job ──────────────────────────────────────────────────────────

/** What the record of a holder says, read with the database's `now()`. */
export interface HolderRecord {
  readonly lastSeenAt: Date;
  readonly stoppedAt: Date | null;
}

/** Why a holder is gone. */
export type HolderGoneHow = 'stopped' | 'no_record' | 'silent' | 'none';

export type Holder =
  /** This instance. `held`: a run of this process is executing the job. */
  | { readonly kind: 'self'; readonly held: boolean }
  /** Another instance, beating. */
  | { readonly kind: 'alive'; readonly id: string; readonly lastSeenAt: Date }
  /**
   * Another instance that has not beaten for `silentInstanceMs`, while THIS
   * instance has not been present long enough to vouch that the silence is
   * real (it slept, it just started, it lost the database). Nothing is
   * decided on it.
   */
  | { readonly kind: 'undecided'; readonly id: string; readonly lastSeenAt: Date }
  | {
      readonly kind: 'gone';
      readonly id: string | null;
      readonly how: HolderGoneHow;
      readonly lastSeenAt: Date | null;
      readonly stoppedAt: Date | null;
    };

/**
 * Who holds a job, and whether it is running. `claimedBy` is the row's
 * holder, `record` its `runner_instances` row (null: none), `dbNow` the
 * database's clock at the read.
 */
export function judgeHolder(
  input: {
    readonly jobId: string;
    readonly claimedBy: string | null;
    readonly record: HolderRecord | null;
    readonly dbNow: Date;
  },
  presence: Presence,
  settings: JobLivenessSettings = JOB_LIVENESS,
): Holder {
  const { claimedBy, record, dbNow } = input;
  if (claimedBy === null) {
    // Claimed by a version that did not record its holder: that process has
    // stopped (this column came with the migration the new process applied).
    return { kind: 'gone', id: null, how: 'none', lastSeenAt: null, stoppedAt: null };
  }
  if (claimedBy === presence.instanceId) {
    return { kind: 'self', held: presence.holds(input.jobId) };
  }
  if (record === null) {
    return { kind: 'gone', id: claimedBy, how: 'no_record', lastSeenAt: null, stoppedAt: null };
  }
  if (record.stoppedAt !== null) {
    return {
      kind: 'gone',
      id: claimedBy,
      how: 'stopped',
      lastSeenAt: record.lastSeenAt,
      stoppedAt: record.stoppedAt,
    };
  }
  const silenceMs = dbNow.getTime() - record.lastSeenAt.getTime();
  if (silenceMs <= settings.silentInstanceMs) {
    return { kind: 'alive', id: claimedBy, lastSeenAt: record.lastSeenAt };
  }
  if (presence.presentFor(dbNow) < settings.silentInstanceMs) {
    return { kind: 'undecided', id: claimedBy, lastSeenAt: record.lastSeenAt };
  }
  return {
    kind: 'gone',
    id: claimedBy,
    how: 'silent',
    lastSeenAt: record.lastSeenAt,
    stoppedAt: null,
  };
}

// ─── The decision ─────────────────────────────────────────────────────────────

/** Statuses a delegated child is still working in. */
const CHILD_LIVE_STATUSES: readonly string[] = [
  'pending',
  'processing',
  'awaiting_delegation',
  'awaiting_approval',
];

/** What a sweeper read about one row, for `decideJob`. */
export type JobFacts =
  | {
      readonly status: 'processing';
      readonly holder: Holder;
      /**
       * Tasks are rooted at this job: an orchestrator that handed its work to
       * the task board. Its end belongs to the board's fan-in
       * (`deliverCompletedRoots`), whether its tasks still run or have all
       * ended and wait to be compiled.
       */
      readonly onBoard: boolean;
      readonly stuckForMs: number | null;
    }
  | {
      readonly status: 'awaiting_delegation';
      /** A run of this process executes the parent or its child. */
      readonly inFlightHere: boolean;
      /**
       * The child the parent waits for: `null` when no delegation is recorded
       * on the parent, `{ status: null }` when the child row does not exist.
       */
      readonly child: { readonly status: string | null } | null;
      readonly stuckForMs: number | null;
    }
  | {
      readonly status: 'awaiting_approval';
      readonly inFlightHere: boolean;
      /** Gating requests still waiting for an answer. */
      readonly openRequests: number;
      /** Gating requests answered (or expired) whose call has not run yet. */
      readonly resolvedRequests: number;
      readonly stuckForMs: number | null;
    }
  | {
      readonly status: 'pending';
      readonly inFlightHere: boolean;
      /** No runner ever claimed this job (`claim_generation = 0`). */
      readonly neverClaimed: boolean;
      /** The request's age on the database's clock. */
      readonly requestAgeMs: number;
      readonly stuckForMs: number | null;
    };

/** What a sweeper does with a row. Exactly one answer per row. */
export type JobVerdict =
  | {
      readonly kind: 'leave';
      readonly because:
        | 'in_flight_here'
        | 'holder_alive'
        | 'holder_undecided'
        | 'on_board'
        | 'child_working'
        | 'approval_open'
        | 'nothing_to_resume'
        | 'not_stuck_yet';
    }
  /** Take the job from its holder, which is gone: resume it or fail it (`orphanDecision`). */
  | { readonly kind: 'take_from_holder'; readonly holder: Holder }
  /** Give the waiting parent the result of its child, which has ended. */
  | { readonly kind: 'give_child_result' }
  /** Resume the job whose approval was resolved. */
  | { readonly kind: 'resume_after_approval' }
  /** Start the pending job whose wake-up was lost. */
  | { readonly kind: 'start' }
  /** Fail the job: nothing can repair it. `reason` is the fact that says why. */
  | {
      readonly kind: 'fail';
      readonly reason: 'no_delegation_recorded' | 'child_missing' | 'never_claimed';
    };

/** `stuckForMs` reached the setting: the row was seen unchanged long enough. */
function stuck(stuckForMs: number | null, settings: JobLivenessSettings): boolean {
  return stuckForMs !== null && stuckForMs >= settings.stuckRowMs;
}

/**
 * THE decision every sweeper takes, for every job kind (a head job, a
 * delegated child, a board task, a CLI runtime job: none is named here,
 * because none decides differently). Pure: the sweepers read the facts and
 * write the outcome.
 */
export function decideJob(
  facts: JobFacts,
  settings: JobLivenessSettings = JOB_LIVENESS,
): JobVerdict {
  switch (facts.status) {
    case 'processing': {
      // An orchestrator that handed its work to the task board stays
      // `processing` and no run holds it: the board's fan-in ends it, never
      // a sweeper (it would fail, or replay, a root whose tasks are done
      // and only wait to be compiled).
      if (facts.onBoard) return { kind: 'leave', because: 'on_board' };
      const h = facts.holder;
      switch (h.kind) {
        case 'self':
          if (h.held) return { kind: 'leave', because: 'in_flight_here' };
          // Claimed by this instance and held by none of its runs: no one
          // will ever move it again, once it has been seen so long enough
          // to rule out a write in progress.
          return stuck(facts.stuckForMs, settings)
            ? { kind: 'take_from_holder', holder: h }
            : { kind: 'leave', because: 'not_stuck_yet' };
        case 'alive':
          return { kind: 'leave', because: 'holder_alive' };
        case 'undecided':
          return { kind: 'leave', because: 'holder_undecided' };
        case 'gone':
          return { kind: 'take_from_holder', holder: h };
      }
      break;
    }
    case 'awaiting_delegation': {
      if (facts.inFlightHere) return { kind: 'leave', because: 'in_flight_here' };
      if (facts.child && facts.child.status !== null) {
        if (CHILD_LIVE_STATUSES.includes(facts.child.status)) {
          return { kind: 'leave', because: 'child_working' };
        }
      }
      if (!stuck(facts.stuckForMs, settings)) return { kind: 'leave', because: 'not_stuck_yet' };
      if (facts.child === null) return { kind: 'fail', reason: 'no_delegation_recorded' };
      if (facts.child.status === null) return { kind: 'fail', reason: 'child_missing' };
      return { kind: 'give_child_result' };
    }
    case 'awaiting_approval': {
      if (facts.inFlightHere) return { kind: 'leave', because: 'in_flight_here' };
      if (facts.openRequests > 0) return { kind: 'leave', because: 'approval_open' };
      if (facts.resolvedRequests === 0) return { kind: 'leave', because: 'nothing_to_resume' };
      return stuck(facts.stuckForMs, settings)
        ? { kind: 'resume_after_approval' }
        : { kind: 'leave', because: 'not_stuck_yet' };
    }
    case 'pending': {
      if (facts.inFlightHere) return { kind: 'leave', because: 'in_flight_here' };
      // A job the system put back in the queue (a resume, a repaired
      // parent) is a continuation, never an abandoned request.
      if (facts.neverClaimed && facts.requestAgeMs > settings.pendingAbandonMs) {
        return { kind: 'fail', reason: 'never_claimed' };
      }
      return stuck(facts.stuckForMs, settings)
        ? { kind: 'start' }
        : { kind: 'leave', because: 'not_stuck_yet' };
    }
  }
  // Unreachable: `facts.status` is exhaustive.
  throw new Error(`decideJob: unknown status ${(facts as { status: string }).status}`);
}

/**
 * The database's clock, in milliseconds, as a column of a select: every row
 * of one statement carries the same instant (`now()` is the transaction's).
 */
export const DB_NOW_MS = sql<string>`(extract(epoch from now()) * 1000)::bigint`;
