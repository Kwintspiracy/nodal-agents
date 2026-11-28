-- EVERY CHANGE TO A FACT KEEPS THE PREVIOUS STATE, AND STATES WHAT IT READ.
--
-- A fact entered memory through one guarded function (`createMemory`); a
-- dozen paths changed it afterwards with a bare UPDATE, and none kept the
-- text it replaced. They now all go through `mutateMemory`
-- (packages/memory/src/mutate.ts), which:
--   - applies a change only if the row is still the version the caller read
--     (`agent_memory.version`, bumped by every change);
--   - honours the owner's marks (a fact the owner wrote, a pinned fact) in the
--     WHERE of its UPDATE, for every caller that is not the owner;
--   - writes, in the same transaction, the state the fact had BEFORE the
--     change into `agent_memory_versions`, with who or what changed it.
--
-- Usage counters (`access_count`, `last_accessed_at`) and the derived vector
-- are not part of the fact: they do not bump the version.
--
-- Existing installs: every row starts at version 1 with no history. A text
-- an automatic pass rewrote before this migration is not recoverable; nothing
-- here pretends otherwise.
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_memory_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES agent_memory(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  version integer NOT NULL,
  fact text NOT NULL,
  category text,
  importance integer,
  importance_locked boolean NOT NULL,
  archived boolean NOT NULL,
  valid_to timestamptz,
  changed_by text NOT NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  action text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_memory_versions_changed_by_check
    CHECK (changed_by IN ('owner','agent','curator','lifecycle')),
  CONSTRAINT agent_memory_versions_action_check
    CHECK (action IN ('edit','archive','retire','restore','rescore','pin','unpin','revert'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_memory_versions_memory
  ON agent_memory_versions (memory_id, version DESC);
