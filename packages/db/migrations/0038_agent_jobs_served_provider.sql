-- Served-upstream observability (P0-B). Tracks which upstream provider actually
-- handled a given job execution (e.g. 'DeepSeek' when routed via OpenRouter's
-- provider-order preference). Populated from providerMetadata.openrouter.provider
-- on each LLM call; only the LAST non-empty value is stored per job. NULL for
-- providers that don't report upstream identity (Anthropic, Ollama, etc.).
ALTER TABLE "agent_jobs"
  ADD COLUMN IF NOT EXISTS "served_provider" text;
