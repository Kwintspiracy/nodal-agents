-- Cache-aware token budget (Guard 1a). The cumulative per-job token budget now
-- counts EFFECTIVE (non-cached) input — inputTokens minus cachedInputTokens —
-- so a job that re-sends a prompt-cached history (cheap, ~10x via caching) is
-- no longer killed at the budget wall as if every re-send were fresh tokens.
-- This column persists the cumulative effective-input across self-chain resumes,
-- mirroring input_tokens / output_tokens.
ALTER TABLE "agent_jobs"
  ADD COLUMN IF NOT EXISTS "effective_input_tokens" integer DEFAULT 0;

-- Backfill in-flight (resumable) jobs conservatively: seed effective from the
-- already-accumulated raw input so a resume AFTER this migration never
-- under-counts (treats prior raw as fully effective). Terminal jobs never
-- resume, so this only matters for jobs suspended in awaiting_* at upgrade time.
UPDATE "agent_jobs"
SET "effective_input_tokens" = COALESCE("input_tokens", 0)
WHERE COALESCE("effective_input_tokens", 0) = 0
  AND COALESCE("input_tokens", 0) > 0
  AND "completed_at" IS NULL;
