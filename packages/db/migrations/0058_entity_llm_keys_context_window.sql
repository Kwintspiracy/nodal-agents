-- É-3 (audit sécu 2026-07-07): per-model context window for custom/local models
-- the catalog can't know. NULL ⇒ fall back to the catalogued value or
-- DEFAULT_CONTEXT_WINDOW. Used window-relative to trigger conversation
-- compaction before the model overflows (a too-large default silently killed
-- local 8-16K models mid-conversation).
ALTER TABLE "entity_llm_keys" ADD COLUMN "context_window" integer;
