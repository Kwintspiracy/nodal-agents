-- Étape D du plan « agents sous abonnement » / Lot A de l'audit
-- reproductibilité (2026-08-19) : la trace d'INFÉRENCE.
--
-- llm_calls : une ligne par appel LLM (par TENTATIVE de maillon de failover) —
-- modèle effectif réellement servi (ferme le trou « maillon fallback sans
-- modèle → MODEL_CATALOG[provider][0] », réinterprétable), provider, clé,
-- effort, toolChoice, outils PROPOSÉS (noms + hash), tokens, coût, durée,
-- flag failover, erreur terminale. Écrite par un sink injecté par le runner
-- dans packages/llm (qui ne dépend pas de la DB). Couvre job + chat +
-- curators + réflexion + cron d'un coup.
--
-- tool_calls.tool_call_id / approval_requests.tool_call_id : raccordent la
-- copie intégrale des sorties d'outils au transcript (tool_use id du AI SDK)
-- et permettent au rejeu post-approbation de viser le marqueur EXACT au lieu
-- d'apparier par nom d'outil.

CREATE TABLE IF NOT EXISTS "llm_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "job_id" uuid REFERENCES "agent_jobs"("id") ON DELETE SET NULL,
  "source" text NOT NULL,
  "turn" integer,
  "model_requested" text,
  "model_effective" text NOT NULL,
  "provider" text NOT NULL,
  "llm_key_id" uuid,
  "reasoning_effort" text,
  "tool_choice" text,
  "tool_names" text[],
  "tools_hash" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "cached_tokens" integer,
  "cost_usd" real,
  "duration_ms" integer,
  "failover" boolean NOT NULL DEFAULT false,
  "error" text,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_llm_calls_job" ON "llm_calls" ("job_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_llm_calls_entity_created" ON "llm_calls" ("entity_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_llm_calls_agent_created" ON "llm_calls" ("agent_id","created_at");

ALTER TABLE "tool_calls" ADD COLUMN IF NOT EXISTS "tool_call_id" text;
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "tool_call_id" text;
