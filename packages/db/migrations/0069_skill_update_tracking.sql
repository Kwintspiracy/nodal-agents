-- Community skill update tracking (Suivi de mises à jour des skills
-- communautaires). Adds the 3 columns the check-updates cron phase
-- (run-skill-update-check.ts) and the POST /api/skills/update route
-- read/write: update_available (surfaced in the dashboard so the user can
-- review + apply), update_detail (what changed at the last check, or NULL
-- before the first check ever runs), and last_update_check_at (throttle
-- timestamp for the cron phase).
ALTER TABLE "agent_skills" ADD COLUMN "update_available" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "update_detail" jsonb;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "last_update_check_at" timestamp with time zone;
