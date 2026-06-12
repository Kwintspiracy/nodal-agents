-- Real dollar cost budget (Guard 1e). Track what was ACTUALLY BILLED per job
-- (not token proxies) so the runner can enforce a hard dollar cap and the
-- dashboard can surface real $/job cost. Populated by OpenRouter when
-- `usage:{include:true}` is sent — `usage.cost` in the response lands in
-- providerMetadata.openrouter.usage.cost on the AI SDK result. NULL / 0 for
-- providers that don't report per-call cost (Anthropic, Ollama, etc.).
--
-- Stored as real (float4) — sub-cent values are common (e.g. $0.00056).
-- Default 0 so existing rows are valid without a backfill.
ALTER TABLE "agent_jobs"
  ADD COLUMN IF NOT EXISTS "total_cost_usd" real DEFAULT 0;
