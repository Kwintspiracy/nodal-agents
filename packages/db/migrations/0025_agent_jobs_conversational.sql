-- 0025_agent_jobs_conversational.sql
-- V4 — in-app ROOT chat, "jobless" conversation model (2026-05-31):
--   A chat turn that only used conversational tools (text + memory + delivery)
--   is conversation, not work — it belongs in /chat, never in /jobs. The runner
--   flags it at completion; the dashboard filters Runs/stats on this column.
--   Default false → all existing + non-chat jobs remain visible as Runs.

ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS conversational boolean NOT NULL DEFAULT false;
