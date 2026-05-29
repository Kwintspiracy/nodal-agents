-- 0021_entities_root_agent_grants.sql
-- Wave 1 — V4 ROOT agent foundation (2026-05-29):
--   1. ADD COLUMN entities.root_agent_id  (nullable FK → agents.id, set null on delete)
--   2. ADD COLUMN entities.root_grants    (jsonb, not null, default '{}')
--   3. CREATE INDEX idx_entities_root_agent_id
--
-- All steps are idempotent (IF NOT EXISTS / IF EXISTS guards).

-- ─── 1. root_agent_id ────────────────────────────────────────────────────────

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS root_agent_id uuid
    REFERENCES agents(id) ON DELETE SET NULL;

-- ─── 2. root_grants ──────────────────────────────────────────────────────────

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS root_grants jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ─── 3. Index ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_entities_root_agent_id ON entities(root_agent_id);
