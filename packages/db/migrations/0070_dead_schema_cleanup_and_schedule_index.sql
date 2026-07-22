-- Pre-0.8 audit cleanup. Drops schema that no production code ever read or
-- wrote: three scaffolding tables from migration 0000 (rate_limits,
-- agent_plugins, configurator_sessions — only their own CRUD/constraint tests
-- ever touched them) and two legacy columns the approval gate never reads
-- (agents.requires_approval, agent_skill_assignments.approval_overrides —
-- the gate reads approval_rules and the per-operation adapter descriptors).
-- Also adds the missing index behind the per-tick schedule queries in
-- cron/run-schedules.ts: the no-overlap guard (schedule_id + status) and the
-- daily budget rollup (schedule_id + created_at SUM) previously seq-scanned
-- agent_jobs; the (schedule_id, created_at) prefix serves both.
DROP TABLE IF EXISTS "rate_limits";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_plugins";--> statement-breakpoint
DROP TABLE IF EXISTS "configurator_sessions";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN IF EXISTS "requires_approval";--> statement-breakpoint
ALTER TABLE "agent_skill_assignments" DROP COLUMN IF EXISTS "approval_overrides";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_jobs_schedule_created" ON "agent_jobs" ("schedule_id","created_at");
