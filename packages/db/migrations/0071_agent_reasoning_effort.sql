-- Per-agent reasoning effort (feature "reasoning effort par agent", 2026-07-20).
-- NULL = Auto (provider default, byte-identical to pre-feature behavior).
-- Values: 'off' | 'low' | 'medium' | 'high' | 'max' — validated at the app
-- layer against the model's declared reasoningControl (model-catalog.ts);
-- kept as free text in DB so a catalog scale change never needs a migration.
-- Per-fallback efforts live INSIDE the existing fallback_chain jsonb entries
-- ({keyId, model, reasoningEffort?}) — no column needed there.
ALTER TABLE "agents" ADD COLUMN "reasoning_effort" text;
