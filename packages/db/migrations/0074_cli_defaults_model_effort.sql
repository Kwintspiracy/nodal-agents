-- Étape B-bis (2026-08-19, demande Quentin) : quand la capacité Coding CLI est
-- active, l'utilisateur choisit le modèle et l'effort PAR DÉFAUT de chaque
-- provider (claude / codex) ; l'agent peut surcharger par tâche via les inputs
-- optionnels de code_task. NULL = défauts du CLI (comportement d'avant).
-- cli_runs enregistre ce qui a été EFFECTIVEMENT demandé (audit + coût).

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cli_defaults" jsonb;
ALTER TABLE "cli_runs" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "cli_runs" ADD COLUMN IF NOT EXISTS "effort" text;
