-- conversation_reads — the read marker of one person on one conversation (#209).
--
-- Until 2026-09-19 the product kept no read state at all, so the dot in front
-- of a thread could only mean "waits for you" or "a run is going". This table
-- is what was missing.
--
-- One row per (person, conversation) — never a column on `conversations`: a
-- read belongs to whoever read. `read_at` is written when the thread is OPENED
-- on the dashboard, never by a channel delivery.
--
-- UNREAD is derived, not stored: a conversation is unread when its
-- `updated_at` (bumped by every agent reply and every incoming channel
-- message) is newer than `read_at`, or when no row exists here at all.
CREATE TABLE IF NOT EXISTS "conversation_reads" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "read_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("user_id", "conversation_id")
);

-- The other direction — every marker of one conversation. PostgreSQL does not
-- index a foreign key on its own, and deleting a conversation would scan the
-- whole table without this one.
CREATE INDEX IF NOT EXISTS "idx_conversation_reads_conversation"
  ON "conversation_reads" ("conversation_id");
