-- 0028_conversations.sql
-- V4 chat — multi-conversation backbone (2026-06-01):
--   Group chat_messages under named `conversations` (the sidebar entries), so
--   the chat gets multiple threads, "+ New", recency sort, and a clean history
--   model. Replaces the single hardcoded thread_id on chat_messages.

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_entity_agent
  ON conversations (entity_id, agent_id, updated_at);

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;

-- thread_id is superseded by conversation_id. Existing dev rows (if any) had
-- thread_id='main' and get a NULL conversation_id (orphaned, not shown).
ALTER TABLE chat_messages DROP COLUMN IF EXISTS thread_id;

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages (conversation_id, created_at);
