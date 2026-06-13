-- Tier-2 CURATOR cadence tracker.
-- Per-entity timestamp of the last LLM consolidation pass. NULL = never run.
-- Used by run-curator.ts to gate the first-run-deferred pattern (skip first
-- run, set to now(), run on subsequent ticks beyond CURATOR_INTERVAL_DAYS).

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "last_curator_run_at" timestamptz;
