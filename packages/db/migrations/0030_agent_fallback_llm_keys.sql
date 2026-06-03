-- Guard 2 (provider failover): ordered LLM-key fallback chain per agent.
-- When the agent's primary key (llm_key_id) exhausts retries / times out /
-- hits quota mid-job, the runner fails over to these keys in order; all-down
-- fails loud (`all_providers_failed`). Empty default = no failover.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "fallback_llm_key_ids" uuid[] DEFAULT '{}'::uuid[];
