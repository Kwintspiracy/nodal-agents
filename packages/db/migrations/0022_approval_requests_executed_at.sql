-- 0022_approval_requests_executed_at.sql
-- Approval-gate execute-on-resume (2026-05-29):
--   ADD COLUMN approval_requests.executed_at (nullable timestamptz)
--
-- When execute.ts resumes a job, it checks for approved/rejected requests
-- where executed_at IS NULL, executes the tool, and stamps executed_at = now().
-- This prevents double-execution on duplicate resume triggers.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;
