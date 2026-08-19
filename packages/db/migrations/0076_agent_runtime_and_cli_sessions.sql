-- Étape E du plan « agents sous abonnement » (2026-08-19) : le type d'agent
-- « runtime Claude Code ». `agents.runtime` est une DONNÉE (invariant #1) :
-- 'nodal' (défaut) = la boucle du runner ; 'claude-code' = l'agent EST une
-- session Claude Code (persona injectée, canaux/cron/workspace/budget côté
-- Nodal, boucle/outils/contexte côté CLI) ; 'codex' réservé (fail loud tant
-- que non implémenté). cli_permissions = posture d'outils du runtime, en
-- données. cli_sessions = continuité de session par (agent, conversation)
-- pour `claude --resume`.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "runtime" text NOT NULL DEFAULT 'nodal';
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cli_permissions" jsonb;

DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_check"
    CHECK ("runtime" IN ('nodal', 'claude-code', 'codex'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "cli_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id" uuid REFERENCES "entities"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "conversation_key" text NOT NULL,
  "provider" text NOT NULL,
  "session_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cli_sessions_agent_conversation_unique"
  ON "cli_sessions" ("agent_id","conversation_key");
