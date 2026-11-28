-- A JOB IS ALIVE WHILE THE RUNNER INSTANCE THAT HOLDS IT IS RUNNING.
--
-- The sweepers used to judge a job abandoned when its `updated_at` was older
-- than a threshold on the wall clock. A laptop that slept, a clock that was
-- stepped, or two hosts whose clocks differ made healthy jobs look dead, and
-- the runner reclaimed jobs it was still running itself.
--
-- `runner_instances`: one row per runner process, keyed by the random
-- identity the process draws at start. It beats `last_seen_at` with the
-- database's clock, and writes `stopped_at` when it shuts down cleanly.
-- `host` and `pid` are kept for diagnosis only.
CREATE TABLE IF NOT EXISTS runner_instances (
  id uuid PRIMARY KEY,
  host text NOT NULL,
  pid integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz
);

-- The instance that made the current claim. NULL on every row claimed before
-- this migration: those were held by a process that has stopped (the
-- migration runs at boot), so a sweeper treats them as held by nobody. No FK:
-- an instance row that is gone is a holder nobody can show to be running.
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS claimed_by uuid;

-- What a sweeper observed when it took a job from its holder: a typed fact
-- next to the error code (which holder, in what state, since when).
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS sweeper_observed jsonb;
