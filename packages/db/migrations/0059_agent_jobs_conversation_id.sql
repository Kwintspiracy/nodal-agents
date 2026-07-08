-- Conversation grouping (Jobs page): a conversational thread (Telegram DM,
-- dashboard chat escalation, delegated/task-board child) shares one
-- conversation_id across the jobs it produced, so the UI can collapse a
-- 10-message chat into one row instead of 10 identical-looking job rows.
-- Purely additive/reporting — the runner's execution path never reads this
-- column. NULL for non-conversational jobs (cron/schedule/webhook with no
-- parent). See apps/runner/src/job/conversation-id.ts for the stamping rule.
ALTER TABLE "agent_jobs" ADD COLUMN "conversation_id" uuid;
--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_entity_conversation" ON "agent_jobs" ("entity_id","conversation_id");
