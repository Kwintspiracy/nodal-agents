-- UN BUDGET PAR RUN, ET UN DÉLAI D'ATTENTE PAR AGENT (issue #442).
--
-- 1. `entities.max_run_cost_usd` : ce qu'un run peut coûter avant d'être
--    arrêté, par l'espace. Le plafond existait déjà (garde 1e du runner, 2 $),
--    mais il ne se réglait que par la variable d'environnement
--    `MAX_COST_PER_JOB_USD`, invisible depuis le produit, et il ARRÊTAIT le
--    run sans livrer ce qui était déjà écrit. LE DÉFAUT EST 2, la valeur que
--    le runner applique aujourd'hui : une migration ne change le comportement
--    de personne. `0` = aucun plafond, un choix explicite.
--
-- 2. `entities.max_run_hours` : combien de temps un run peut TOURNER (les
--    attentes d'approbation et de délégation ne comptent pas, c'est
--    `agent_jobs.total_duration_ms`). `0` = aucune limite, le défaut, puisque
--    rien ne limitait la durée avant.
--
-- 3. `agents.idle_timeout_seconds` : combien de temps un appel au modèle peut
--    rester sans premier jeton pour CET agent (Researcher, qui réfléchit
--    longtemps). NULL = la plateforme décide (120 s, relevé avec la taille du
--    contexte et l'effort de raisonnement). Une valeur posée GAGNE toujours
--    sur la valeur implicite (Hermes, `_stale_timeout_is_explicit`).
--
-- LES CHECK SONT ICI, pas seulement dans le formulaire : ces colonnes bornent
-- une boucle du runner (invariant #8). Mille dollars, trois jours, une heure
-- d'attente : au-delà, ce n'est plus un réglage, c'est une faute de frappe.
ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "max_run_cost_usd" real NOT NULL DEFAULT 2;
ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "max_run_hours" real NOT NULL DEFAULT 0;
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "idle_timeout_seconds" integer;

DO $$
BEGIN
  ALTER TABLE "entities"
    ADD CONSTRAINT "entities_max_run_cost_usd_check"
    CHECK ("max_run_cost_usd" >= 0 AND "max_run_cost_usd" <= 1000);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "entities"
    ADD CONSTRAINT "entities_max_run_hours_check"
    CHECK ("max_run_hours" >= 0 AND "max_run_hours" <= 72);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "agents_idle_timeout_seconds_check"
    CHECK ("idle_timeout_seconds" IS NULL OR ("idle_timeout_seconds" >= 30 AND "idle_timeout_seconds" <= 3600));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
