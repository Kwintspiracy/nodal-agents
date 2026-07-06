-- Dedup pass (audit#2 follow-up): these six tables never had the UNIQUE
-- constraints below, and their pre-fix write paths were check-then-insert
-- (raceable) — so an upgraded install may already carry duplicate rows. A bare
-- ADD CONSTRAINT / CREATE UNIQUE INDEX validates existing rows and aborts the
-- whole migration (Postgres 23505) if any duplicate exists, bricking `up` with
-- no recovery. Follow migration 0007's precedent: collapse each duplicate group
-- to a single survivor BEFORE adding the constraint. Survivor = most recently
-- updated/created row (id as final, always-unique tiebreaker); COALESCE guards
-- NULL timestamps; IS NOT DISTINCT FROM matches the NULLS NOT DISTINCT semantics
-- of the entity_id keys. On a clean install (no duplicates) every DELETE is a
-- no-op.
DELETE FROM "approval_rules" a USING "approval_rules" b
WHERE a."id" <> b."id"
  AND a."entity_id" IS NOT DISTINCT FROM b."entity_id"
  AND a."agent_id" IS NOT DISTINCT FROM b."agent_id"
  AND a."tool_name" = b."tool_name"
  AND (COALESCE(a."updated_at", 'epoch'::timestamptz) < COALESCE(b."updated_at", 'epoch'::timestamptz)
       OR (COALESCE(a."updated_at", 'epoch'::timestamptz) = COALESCE(b."updated_at", 'epoch'::timestamptz) AND a."id" < b."id"));--> statement-breakpoint
DELETE FROM "agent_skill_assignments" a USING "agent_skill_assignments" b
WHERE a."agent_id" = b."agent_id"
  AND a."skill_id" = b."skill_id"
  AND a."id" < b."id";--> statement-breakpoint
DELETE FROM "agent_assignments" a USING "agent_assignments" b
WHERE a."orchestrator_id" = b."orchestrator_id"
  AND a."sub_agent_id" = b."sub_agent_id"
  AND (COALESCE(a."created_at", 'epoch'::timestamptz) < COALESCE(b."created_at", 'epoch'::timestamptz)
       OR (COALESCE(a."created_at", 'epoch'::timestamptz) = COALESCE(b."created_at", 'epoch'::timestamptz) AND a."id" < b."id"));--> statement-breakpoint
DELETE FROM "agent_plugins" a USING "agent_plugins" b
WHERE a."id" <> b."id"
  AND a."entity_id" IS NOT DISTINCT FROM b."entity_id"
  AND a."slug" = b."slug"
  AND (COALESCE(a."updated_at", 'epoch'::timestamptz) < COALESCE(b."updated_at", 'epoch'::timestamptz)
       OR (COALESCE(a."updated_at", 'epoch'::timestamptz) = COALESCE(b."updated_at", 'epoch'::timestamptz) AND a."id" < b."id"));--> statement-breakpoint
DELETE FROM "mcp_connections" a USING "mcp_connections" b
WHERE a."entity_id" = b."entity_id"
  AND a."slug" = b."slug"
  AND (COALESCE(a."updated_at", 'epoch'::timestamptz) < COALESCE(b."updated_at", 'epoch'::timestamptz)
       OR (COALESCE(a."updated_at", 'epoch'::timestamptz) = COALESCE(b."updated_at", 'epoch'::timestamptz) AND a."id" < b."id"));--> statement-breakpoint
DELETE FROM "entity_members" a USING "entity_members" b
WHERE a."entity_id" = b."entity_id"
  AND a."user_id" = b."user_id"
  AND (COALESCE(a."created_at", 'epoch'::timestamptz) < COALESCE(b."created_at", 'epoch'::timestamptz)
       OR (COALESCE(a."created_at", 'epoch'::timestamptz) = COALESCE(b."created_at", 'epoch'::timestamptz) AND a."id" < b."id"));--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_entity_agent_tool_unique" UNIQUE NULLS NOT DISTINCT("entity_id","agent_id","tool_name");--> statement-breakpoint
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_agent_skill_unique" UNIQUE("agent_id","skill_id");--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_orchestrator_sub_agent_unique" UNIQUE("orchestrator_id","sub_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_root_job_id" ON "agent_tasks" USING btree ("root_job_id");--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_completed_at_null" ON "agent_jobs" USING btree ("completed_at") WHERE "completed_at" IS NULL;--> statement-breakpoint
DROP INDEX "idx_jobs_parent";--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_entity_slug_unique" UNIQUE NULLS NOT DISTINCT("entity_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_entity_slug_unique" ON "mcp_connections" USING btree ("entity_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_members_entity_user_unique" ON "entity_members" USING btree ("entity_id","user_id");
