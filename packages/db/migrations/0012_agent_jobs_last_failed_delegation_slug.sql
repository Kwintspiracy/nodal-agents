ALTER TABLE "agent_jobs" DROP COLUMN "failed_delegations_count";
ALTER TABLE "agent_jobs" ADD COLUMN "last_failed_delegation_slug" text;
