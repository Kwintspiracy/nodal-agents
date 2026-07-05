ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_entity_agent_tool_unique" UNIQUE NULLS NOT DISTINCT("entity_id","agent_id","tool_name");--> statement-breakpoint
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_agent_skill_unique" UNIQUE("agent_id","skill_id");--> statement-breakpoint
ALTER TABLE "agent_assignments" ADD CONSTRAINT "agent_assignments_orchestrator_sub_agent_unique" UNIQUE("orchestrator_id","sub_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_tasks_root_job_id" ON "agent_tasks" USING btree ("root_job_id");--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_completed_at_null" ON "agent_jobs" USING btree ("completed_at") WHERE "completed_at" IS NULL;--> statement-breakpoint
DROP INDEX "idx_jobs_parent";--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_entity_slug_unique" UNIQUE NULLS NOT DISTINCT("entity_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_entity_slug_unique" ON "mcp_connections" USING btree ("entity_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_members_entity_user_unique" ON "entity_members" USING btree ("entity_id","user_id");
