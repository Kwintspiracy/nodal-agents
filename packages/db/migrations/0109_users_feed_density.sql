-- How dense a person reads a thread (#132, #135).
-- 'folded': the agent's answer first, the run's work under one summary row.
-- 'unfolded': the work open from the start, as the run page shows it.
-- A per-person preference, never a code constant: the builder wants the work,
-- the reader wants the answer.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "feed_density" text NOT NULL DEFAULT 'folded';

DO $$
BEGIN
  ALTER TABLE "users"
    ADD CONSTRAINT "users_feed_density_check"
    CHECK ("feed_density" IN ('folded', 'unfolded'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
