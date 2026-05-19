-- Migration 0013 — cascade FK references to agents.id so DELETE FROM agents
-- propagates through dependent tables instead of throwing a FK violation.
--
-- Background: live bug 2026-05-20. Clicking "Delete" on an agent in the
-- dashboard surfaced a generic "Failed to delete agent" toast because five
-- tables referenced agents.id with ON DELETE NO ACTION. Decision (Quentin
-- 2026-05-20): CASCADE everywhere — when the user removes an agent, sweep
-- the agent's history (jobs, runs, tasks, memory, approvals) with it.
-- Archive-agents is a separate feature for later.

ALTER TABLE "approval_requests"
  DROP CONSTRAINT "approval_requests_agent_id_agents_id_fk",
  ADD CONSTRAINT "approval_requests_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "agent_jobs"
  DROP CONSTRAINT "agent_jobs_agent_id_agents_id_fk",
  ADD CONSTRAINT "agent_jobs_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "agent_memory"
  DROP CONSTRAINT "agent_memory_agent_id_agents_id_fk",
  ADD CONSTRAINT "agent_memory_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "agent_tasks"
  DROP CONSTRAINT "agent_tasks_created_by_agent_id_agents_id_fk",
  ADD CONSTRAINT "agent_tasks_created_by_agent_id_agents_id_fk"
    FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "agent_tasks"
  DROP CONSTRAINT "agent_tasks_assigned_agent_id_agents_id_fk",
  ADD CONSTRAINT "agent_tasks_assigned_agent_id_agents_id_fk"
    FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "agent_runs"
  DROP CONSTRAINT "agent_runs_agent_id_agents_id_fk",
  ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
