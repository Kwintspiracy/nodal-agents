-- Learning-loop columns for agent_skills (Phase A).
-- created_by: provenance — who created this skill ('user' | 'system' | 'agent').
--   Default 'user' for forward-compatibility; backfilled to 'system' for
--   community/bundled skills below.
-- state: lifecycle state — 'active' (default) | 'stale' | 'archived'.
--   No hard-delete path — skills are archived, never deleted.
-- last_used_at: fire-and-forget timestamp, bumped each time the skill is injected
--   into a job's system prompt. NULL = never used. Used to surface stale skills.
-- patch_count: how many agent-authored patches have been applied. Starts at 0.
-- archived_at: when the skill was moved to state='archived'. NULL while active.

ALTER TABLE "agent_skills"
  ADD COLUMN IF NOT EXISTS "created_by" text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "last_used_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "patch_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

-- Backfill: community/bundled skills are 'system' provenance
UPDATE "agent_skills" SET "created_by" = 'system' WHERE "is_community" = true;
