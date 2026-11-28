// runner_instances — the runner processes that hold jobs (migration 0173).
//
// WHY. A job used to be judged abandoned when its `updated_at` was older than
// a threshold on the wall clock. A laptop that slept, a clock that was
// stepped, or two hosts whose clocks differ made healthy jobs look dead, and
// the runner reclaimed jobs it was still running itself. "Alive" now means
// "held by a runner instance that is running": every claim records the
// instance that made it (`agent_jobs.claimed_by`), and each instance announces
// itself here.
//
// THE IDENTITY. `id` is a random UUID drawn once when the runner process
// starts (`apps/runner/src/runner-identity.ts`), never read from disk and
// never derived from the host name or the pid: a restarted process draws a
// new one, so a process can never be taken for the one before it, and two
// processes (on one host or two) never share one. 122 random bits make a
// collision out of reach.
//
// THE BEAT. A live instance rewrites `last_seen_at` with the DATABASE's
// clock (`now()` in SQL) every heartbeat, and the age of another instance's
// beat is compared with that same clock. No runner clock enters the
// comparison, so a step of one host's clock, or a skew between hosts, moves
// nothing. `stopped_at` is written when an instance shuts down cleanly: its
// jobs are then reclaimable at once.
//
// `host` and `pid` are kept for diagnosis only. No decision reads them: a
// host name is shared by default images and containers, and a pid is reused.

import { pgTable, text, uuid, integer, timestamp } from 'drizzle-orm/pg-core';

export const runnerInstances = pgTable('runner_instances', {
  id: uuid('id').primaryKey(),
  host: text('host').notNull(),
  pid: integer('pid').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
});

export type RunnerInstanceRow = typeof runnerInstances.$inferSelect;
