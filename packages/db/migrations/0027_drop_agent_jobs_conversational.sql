-- 0027_drop_agent_jobs_conversational.sql
-- Revert the short-lived "conversational" flag (migration 0025). The in-app chat
-- is now conversation-first: pure chat lives in chat_messages and never creates
-- an agent_jobs row at all, so flagging/hiding jobs is no longer needed.

ALTER TABLE agent_jobs DROP COLUMN IF EXISTS conversational;
