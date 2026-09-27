-- last_failed_delegation_streak — combien de délégations à
-- `last_failed_delegation_slug` ont échoué D'AFFILÉE sur ce job parent
-- (issue #510).
--
-- Le blocage « ne relance pas le même spécialiste » tombait dès le PREMIER
-- échec : tout orchestrateur était poussé vers un autre agent. Le 25/09 (run
-- 8dfe4684), un rendu est parti vers une équipe de code qui n'avait ni le
-- dossier ni le shell, alors que l'agent qui avait les deux n'a jamais été
-- relancé sur le point précis qui l'avait arrêté. Une relance ciblée est
-- désormais permise ; le deuxième échec consécutif du même agent le bloque.
--
-- Défaut 0 : aucun échec compté sur les lignes existantes. Une ligne qui
-- porte déjà un slug en échec repart donc avec une relance possible.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS last_failed_delegation_streak integer NOT NULL DEFAULT 0;
