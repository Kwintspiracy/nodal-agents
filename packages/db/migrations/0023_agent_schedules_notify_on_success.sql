-- 0023_agent_schedules_notify_on_success.sql
-- Per-schedule success confirmation (2026-05-31):
--   ADD COLUMN agent_schedules.notify_on_success (boolean, not null, default false)
--
-- Opt-in flag. When true, the cron tick sets the fired job's chat_id so the
-- runner forces the agent to deliver a success confirmation before completing.
-- Idempotent (IF NOT EXISTS guard).

ALTER TABLE agent_schedules
  ADD COLUMN IF NOT EXISTS notify_on_success boolean NOT NULL DEFAULT false;
