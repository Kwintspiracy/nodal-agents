-- 0078 — écritures de cache côté trace Nodal + backfill codex (review 2026-08-20).
--
-- (1) llm_calls.cache_creation_tokens : l'AI SDK rapporte inputTokens CACHE
--     INCLUS (fresh + cache_creation + cache_read pour Anthropic) — sans les
--     écritures, « input effectif = input - cache lu » reste gonflé par le
--     poste de coût dominant, et un tour Nodal n'est PAS comparable à un tour
--     CLI (dont input_tokens exclut les deux). Capturé depuis
--     providerMetadata.anthropic.cacheCreationInputTokens (vérifié sur
--     @ai-sdk/anthropic 3.0.76). NULL = provider sans la donnée — jamais 0.
ALTER TABLE "llm_calls" ADD COLUMN IF NOT EXISTS "cache_creation_tokens" integer;

-- (2) Backfill codex : 0077 a changé la sémantique de cli_runs.input_tokens
--     côté parseur codex (désormais stocké HORS cache — la sémantique OpenAI
--     brute inclut le cache lu) sans convertir les lignes existantes, qui
--     restaient surlues de leur part cachée et comptées deux fois (même
--     précédent que le backfill 0036, jobs.effective_input_tokens).
--     Discriminant STRUCTUREL, pas temporel : le nouveau parseur codex écrit
--     toujours cache_creation_tokens (le flux émet cache_write_input_tokens,
--     vérifié live 2026-08-20 ; 0 quand pas d'écritures) — une ligne codex à
--     cache_creation_tokens NULL est donc pré-normalisation. Le garde-fou
--     input >= cached évite tout négatif si un flux atypique déroge.
UPDATE "cli_runs"
SET "input_tokens" = "input_tokens" - "cached_tokens"
WHERE "provider" = 'codex'
  AND "cache_creation_tokens" IS NULL
  AND "cached_tokens" IS NOT NULL
  AND "input_tokens" IS NOT NULL
  AND "input_tokens" >= "cached_tokens";
