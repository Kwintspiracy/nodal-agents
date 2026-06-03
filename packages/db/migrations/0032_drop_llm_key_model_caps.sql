-- Simplify LLM providers: a key is now JUST credentials (provider + API key +
-- base URL + active). The model is chosen per-AGENT, and tool capability is
-- read from the code model catalog at runtime — so these per-key columns are
-- dead weight. Drop them. (0030 fallback_llm_key_ids stays — failover is still a
-- per-key concern.)
ALTER TABLE "entity_llm_keys"
  DROP COLUMN IF EXISTS "default_model",
  DROP COLUMN IF EXISTS "supports_tools",
  DROP COLUMN IF EXISTS "supports_forced_tool_choice";
