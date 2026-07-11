-- Event Triggers, Brique 3: two guards for frequent cron schedules, both
-- proven necessary by live incidents on 2026-07-11 —
--   (a) a 5-min watcher schedule had NO aggregate cost ceiling: at ~$0.03-0.06
--       burned per tick in delegation detours, 288 ticks/day at the per-job $2
--       cap is a $576/day worst case.
--   (b) tick N+1 fired while tick N's job for the SAME schedule was still
--       processing (stale next_run catch-up + a long run) — two concurrent
--       instances of the same watcher (runner-side fix, no schema change).
--
-- daily_budget_usd: per-schedule ceiling (USD), checked in runScheduleTick
-- against the SUM of agent_jobs.total_cost_usd for that schedule since the
-- start of its local day (see run-schedules.ts). Default 5.0 — generous
-- enough not to surprise existing schedules, small enough to bound the
-- worst case.
ALTER TABLE "agent_schedules" ADD COLUMN "daily_budget_usd" real NOT NULL DEFAULT 5.0;--> statement-breakpoint

-- 'budget_exhausted' — a distinct, visible last_status so a budget trip reads
-- in the UI as "intentionally held back" rather than "the run broke" (an
-- ordinary 'failed').
ALTER TABLE "agent_schedules" DROP CONSTRAINT IF EXISTS "agent_schedules_last_status_check";--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_last_status_check" CHECK ("last_status" IN ('success','failed','no_action','budget_exhausted') OR "last_status" IS NULL);
