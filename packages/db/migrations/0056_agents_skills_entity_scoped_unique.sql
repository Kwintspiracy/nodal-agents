-- F-6 (audit #2): agents.slug and agent_skills.slug/name were UNIQUE
-- GLOBALLY across the whole install. Consequences: (a) a 2nd entity/
-- workspace installing the same community skill (e.g. slug 'comfyui') or
-- creating an agent/skill that happens to share a slug or name with another
-- entity's crashed the insert outright; (b) in multi-user mode, slug/name
-- collisions let one entity enumerate or squat another's identifiers.
--
-- Fix: drop the global unique constraints and replace them with composite
-- (entity_id, slug) / (entity_id, name) uniques, NULLS NOT DISTINCT (same
-- pattern as 0000's agent_plugins_entity_slug_unique / approval_rules —
-- entity_id is nullable in both tables, and a plain UNIQUE treats every NULL
-- as distinct, which would let multiple (NULL, 'x') rows back in).
--
-- Safe to apply: the OLD global unique constraints made it structurally
-- impossible for two existing rows to already share a (entity_id, slug) or
-- (entity_id, name) pair, so the new composite constraints cannot fail on
-- current data.
ALTER TABLE "agents" DROP CONSTRAINT "agents_slug_unique";--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_slug_unique";--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_name_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_entity_slug_unique" UNIQUE NULLS NOT DISTINCT("entity_id","slug");--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_entity_slug_unique" UNIQUE NULLS NOT DISTINCT("entity_id","slug");--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_entity_name_unique" UNIQUE NULLS NOT DISTINCT("entity_id","name");
