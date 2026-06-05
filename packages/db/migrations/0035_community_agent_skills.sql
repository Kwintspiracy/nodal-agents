-- Community-installed skills (open Agent Skills / SKILL.md format).
-- is_community marks a skill installed at runtime from an external source (vs a
-- system-catalog skill or a user-authored custom skill). source records the
-- install origin (GitHub URL / skills.sh path) and doubles as the reinstall key.
-- installed_scripts lists the bundled scripts detected at install (.py/.sh/...)
-- — surfaced to the user as a warning, because the runtime does NOT execute
-- skill scripts (agents act through a controlled tool whitelist).
ALTER TABLE "agent_skills"
  ADD COLUMN IF NOT EXISTS "is_community" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "source" text,
  ADD COLUMN IF NOT EXISTS "installed_scripts" jsonb;

CREATE INDEX IF NOT EXISTS "idx_agent_skills_is_community" ON "agent_skills" ("is_community");
