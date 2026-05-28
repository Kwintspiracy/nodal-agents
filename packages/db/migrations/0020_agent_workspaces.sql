-- 0020_agent_workspaces.sql
-- Volet 5 (multi-workspace per agent, 2026-05-28):
--   1. CREATE TABLE agent_workspaces
--   2. Data-migrate existing agents.workspace_root_path into rows
--   3. DROP COLUMN agents.workspace_root_path
--
-- All three steps are idempotent (IF NOT EXISTS / IF EXISTS guards) so a
-- runner that re-applies migrations at boot does not error on a clean DB.

-- ─── 1. Create the new table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  label text NOT NULL,
  path text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_workspaces_agent_label_unique
  ON agent_workspaces (agent_id, label);

CREATE INDEX IF NOT EXISTS idx_agent_workspaces_agent_id
  ON agent_workspaces (agent_id);

-- ─── 2. Data-migrate existing workspace_root_path values ──────────────────────
-- Each migrated agent had exactly one root, so we label it 'workspace'. With a
-- single workspace the label is optional for path resolution anyway; the user
-- can remove + re-add with a custom label later. Skips NULL/empty roots.
-- The IF-column-exists guard makes the block a no-op if re-applied after the
-- column was already dropped.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'workspace_root_path'
  ) THEN
    INSERT INTO agent_workspaces (id, agent_id, entity_id, label, path, position)
    SELECT
      gen_random_uuid(),
      id,
      entity_id,
      'workspace',
      workspace_root_path,
      0
    FROM agents
    WHERE workspace_root_path IS NOT NULL
      AND workspace_root_path <> ''
    ON CONFLICT (agent_id, label) DO NOTHING;
  END IF;
END;
$$;

-- ─── 3. Drop the old column ───────────────────────────────────────────────────

ALTER TABLE agents DROP COLUMN IF EXISTS workspace_root_path;
