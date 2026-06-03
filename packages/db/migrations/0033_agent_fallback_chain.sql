-- Per-fallback model selection (Guard 2). The failover chain now stores
-- (keyId, model) pairs instead of bare key ids, so each fallback runs on a
-- CHOSEN model rather than its provider's catalog default. Backfill existing
-- id arrays with an empty model ('' ⇒ runtime uses the catalog default), then
-- drop the old column.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "fallback_chain" jsonb DEFAULT '[]'::jsonb;

UPDATE "agents"
SET "fallback_chain" = COALESCE(
  (
    SELECT jsonb_agg(jsonb_build_object('keyId', kid::text, 'model', ''))
    FROM unnest("fallback_llm_key_ids") AS kid
  ),
  '[]'::jsonb
)
WHERE "fallback_llm_key_ids" IS NOT NULL
  AND array_length("fallback_llm_key_ids", 1) > 0;

ALTER TABLE "agents"
  DROP COLUMN IF EXISTS "fallback_llm_key_ids";
