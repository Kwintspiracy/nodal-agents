-- COMMENT LE RÉSULTAT D'UN JOB A ÉTÉ PRODUIT (issues #154 et #210).
--
-- `agent_jobs.result` porte le texte rendu à la personne. Rien ne disait D'OÙ
-- ce texte venait, et deux écrans le devinaient :
--
--   le fil (`readsAsReply`) tenait un résultat pour du texte machine dès qu'il
--   commençait par « { » ou « [ » et parsait comme du JSON. Une réponse
--   légitime rendue en tableau JSON lisible était donc refusée, et le fil
--   montrait l'annonce de l'agent à sa place (#154) ;
--
--   la page d'un run cachait la réponse dès qu'un verdict de relecture existait,
--   sans pouvoir dire si cette réponse était les mots de l'agent ou le texte de
--   ses délégués recompilé — un run de code relu perdait sa phrase finale (#210).
--
-- La colonne porte le FAIT, écrit par le runner là où le résultat est finalisé :
--
--   prose — les mots de l'agent : son texte final, son dernier texte repris par
--           le harnais quand il n'a appelé aucun outil de livraison, ou le texte
--           qu'il a publié lui-même par `dashboard_publish`.
--   relay — le texte d'AUTRES jobs, recompilé par le runner : les résultats des
--           enfants d'un parent qui n'a rien écrit, ceux des tâches d'un root de
--           tableau.
--
-- Pas de troisième valeur : `return_result` ne transporte aucun contenu depuis
-- la brique 33, donc aucun chemin n'écrit de charge utile structurée dans
-- `result`. Une valeur que rien ne pose aurait donné aux écrans une distinction
-- sans réalité.
--
-- NULLABLE et SANS DÉFAUT, délibérément : les jobs déjà en base n'ont pas de
-- marque et n'en recevront pas une inventée. NULL veut dire « pas de marque »,
-- et les écrans retombent alors sur l'ancienne heuristique, en le disant.
ALTER TABLE "agent_jobs" ADD COLUMN IF NOT EXISTS "result_kind" text;

ALTER TABLE "agent_jobs" DROP CONSTRAINT IF EXISTS "agent_jobs_result_kind_check";

ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_result_kind_check"
  CHECK ("result_kind" IS NULL OR "result_kind" IN ('prose', 'relay'));
