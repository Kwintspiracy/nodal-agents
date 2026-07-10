-- Event Triggers, Brique 1: a cron-triggered agent must know "since when" — the
-- schedule's PREVIOUS last_run — so a polling-watcher flow has a deterministic
-- cursor instead of relying on agent memory. Two additive columns on agent_jobs:
--   - schedule_id: which schedule fired this job (NULL for non-schedule jobs).
--     ON DELETE SET NULL — deleting a schedule must not orphan its job history.
--   - trigger_context: structured provenance the runner injects into the system
--     prompt (see packages/orchestration/src/system-prompt.ts buildRuntimeBlock).
--     Shape for the cron case: {type:'cron', scheduleName: string, prevRunAt:
--     string | null}. Designed extensible — a future webhook trigger adds
--     type:'webhook' with its own fields; not built here.
ALTER TABLE "agent_jobs" ADD COLUMN "schedule_id" uuid REFERENCES "agent_schedules"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "trigger_context" jsonb;
