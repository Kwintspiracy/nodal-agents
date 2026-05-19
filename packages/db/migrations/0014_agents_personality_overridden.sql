-- Migration 0014 — track user edits to `agents.personality` so the system
-- catalog seeder can refresh canonical personalities on upgrade without
-- clobbering a user's customisations. Mirrors `agent_skills.content_overridden`
-- (introduced in 0007).
--
-- The seeder will treat:
--   personality_overridden = false  → refresh personality from the catalog
--   personality_overridden = true   → leave the user's personality untouched
--
-- The dashboard's new "Reset to default personality" button flips the flag
-- back to false (and writes the catalog personality back into the row).

ALTER TABLE "agents" ADD COLUMN "personality_overridden" boolean NOT NULL DEFAULT false;
