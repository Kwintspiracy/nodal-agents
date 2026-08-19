-- 0077 — cli_runs.cache_creation_tokens (audit tokens 2026-08-19).
-- Le coût d'un run CLI est dominé par l'ÉCRITURE de cache (facturée 1,25×
-- le prix input), que le CLI rapporte (cache_creation_input_tokens) mais que
-- Nodal ne stockait pas : un run affichant « in=8 » coûtait 0,80 $ sans que
-- rien dans la ligne ne l'explique. cached_tokens (lectures) existait déjà ;
-- cette colonne complète la décomposition. NULL = run antérieur ou provider
-- sans la donnée (codex) — jamais 0 deviné.
ALTER TABLE "cli_runs" ADD COLUMN IF NOT EXISTS "cache_creation_tokens" integer;
