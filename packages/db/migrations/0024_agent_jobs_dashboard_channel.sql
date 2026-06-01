-- 0024_agent_jobs_dashboard_channel.sql
-- V4 — in-app ROOT chat (2026-05-31):
--   Allow 'dashboard' as an agent_jobs.channel value so the dashboard chat with
--   the ROOT agent reuses the same job lifecycle + thread continuity as Telegram.
--   Rebuild the CHECK constraint to include 'dashboard'. Idempotent.

ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_channel_check;

ALTER TABLE agent_jobs
  ADD CONSTRAINT agent_jobs_channel_check
  CHECK (channel IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard'));
