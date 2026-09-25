-- UN BUDGET PAR AGENT, TOUS FOURNISSEURS CONFONDUS (issue #447).
--
-- Décision de Quentin, 23/09 : un budget par agent, dans l'onglet Settings de
-- l'agent, qui compte ENSEMBLE les appels d'API de n'importe quel fournisseur
-- (`llm_calls.cost_usd`) et les runs des CLI de code (`cli_runs.cost_usd`).
--
-- Avant : un seul champ, `agents.cli_daily_budget_usd` (défaut 10), qui ne
-- bornait QUE les runs de CLI de code, vivait dans la carte « Call a coding
-- CLI » de l'onglet Autonomy et n'apparaissait que si ce groupe d'outils était
-- actif. Deux autres budgets existaient sans que rien ne les lise :
-- `agents.max_tokens_per_job` et toute la table `agent_budgets` (0 ligne).
--
-- 1. Trois colonnes : plafond du jour, plafond du mois (0 = aucun), et le
--    pourcentage à partir duquel l'écran prévient (80 par défaut, la valeur de
--    l'ancienne `agent_budgets.alert_threshold_pct`).
-- 2. Le plafond CLI d'un agent devient son plafond du jour SEULEMENT là où il
--    s'appliquait (runtime CLI, ou outil code-task rattaché). Ailleurs il ne
--    bornait rien, et en faire un plafond de 10 $ sur les appels d'API
--    arrêterait des agents qui ne l'ont jamais eu. Il compte désormais aussi
--    leurs appels d'API : c'est la décision, et l'écran le dit.
--    UNE EXCEPTION, voulue : un agent au runtime Codex. L'ancienne garde
--    l'exemptait, son plafond (10 $ par défaut) ne bornait donc rien ; il
--    devient un plafond actif, puisque Codex n'est plus exempté (#447). Ces
--    agents GAGNENT un plafond qu'ils n'avaient pas en pratique, visible dans
--    leur onglet Settings (revue de la PR #496).
-- 3. Les colonnes et la table mortes partent.
--
-- IDEMPOTENTE : le repli ne tourne que tant que la colonne CLI existe.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "budget_daily_usd" real NOT NULL DEFAULT 0;
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "budget_monthly_usd" real NOT NULL DEFAULT 0;
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "budget_alert_pct" integer NOT NULL DEFAULT 80;

DO $$
BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_budget_daily_usd_check"
    CHECK ("budget_daily_usd" >= 0 AND "budget_daily_usd" <= 1000);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_budget_monthly_usd_check"
    CHECK ("budget_monthly_usd" >= 0 AND "budget_monthly_usd" <= 10000);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_budget_alert_pct_check"
    CHECK ("budget_alert_pct" >= 1 AND "budget_alert_pct" <= 100);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agents' AND column_name = 'cli_daily_budget_usd'
  ) THEN
    UPDATE "agents" a
    SET "budget_daily_usd" = LEAST(a."cli_daily_budget_usd", 1000)
    WHERE a."cli_daily_budget_usd" > 0
      AND (
        a."runtime" IN ('claude-code', 'codex')
        OR EXISTS (
          SELECT 1
          FROM "agent_skill_assignments" x
          JOIN "agent_skills" k ON k."id" = x."skill_id"
          WHERE x."agent_id" = a."id" AND k."slug" = 'code-task'
        )
      );
    ALTER TABLE "agents" DROP COLUMN "cli_daily_budget_usd";
  END IF;
END $$;

ALTER TABLE "agents" DROP COLUMN IF EXISTS "max_tokens_per_job";
DROP TABLE IF EXISTS "agent_budgets";
