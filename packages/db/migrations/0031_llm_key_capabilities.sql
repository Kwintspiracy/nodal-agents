-- T2 (per-model LLM capabilities): cache a key's tool-calling capability so the
-- runtime can pick the right tool_choice WITHOUT a failed first call. NULL =
-- unknown (runtime assumes supported; the tool_choice floor catches a wrong
-- guess). Set from the model catalog or the live "Test" capability probe.
ALTER TABLE "entity_llm_keys"
  ADD COLUMN IF NOT EXISTS "supports_tools" boolean,
  ADD COLUMN IF NOT EXISTS "supports_forced_tool_choice" boolean;
