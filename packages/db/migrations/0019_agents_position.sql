-- 0019_agents_position.sql
-- Brique A (UX polish sprint, 2026-05-26): manual reorder of agents on the
-- /agents page. The list was sorted by `created_at DESC` in code; this
-- column lets the user override that ordering with the ↑/↓ buttons in the
-- UI without touching the underlying agents.created_at.
--
-- Idempotent: `IF NOT EXISTS` so a runner that re-applies migrations at
-- boot doesn't trip when the column is already there.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

-- Cheap covering index for the ORDER BY in listAgentsAction. Optional but
-- keeps the new sort path off seqscans once an entity has more than a few
-- dozen agents. Same idempotency guard as the column add.
CREATE INDEX IF NOT EXISTS idx_agents_position ON agents (position);
