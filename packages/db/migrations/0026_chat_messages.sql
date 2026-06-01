-- 0026_chat_messages.sql
-- V4 — conversation-first in-app chat (2026-05-31):
--   A conversation is NOT a job. Pure chat turns (text + memory) are stored here
--   and never create an agent_jobs row. Only an ACTION turn escalates to a job,
--   whose id is linked via job_id so the UI shows progress inline.

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  thread_id text NOT NULL DEFAULT 'main',
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON chat_messages (entity_id, agent_id, thread_id, created_at);
