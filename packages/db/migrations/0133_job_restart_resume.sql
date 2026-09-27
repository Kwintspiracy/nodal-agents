-- Reprise après un redémarrage du runner (#443, briques « long runs » 4).
--
-- Un job `processing` que plus aucun runner ne bat était ÉCHOUÉ par le
-- faucheur (`runner_restarted`, cron/reclaim-jobs.ts). Quand son point de
-- reprise existe (au moins un tour sauvegardé par `saveCheckpoint`), il repart
-- désormais de ce tour. Deux faits typés, portés par le job :
--
--   resumed_from_turn  le tour sauvegardé d'où il a repris la dernière fois
--                      (NULL : jamais repris après un redémarrage). L'écran le
--                      dira (#444) ; ce n'est pas une phrase, c'est un fait.
--   restart_resumes    combien de fois il a été repris ainsi. Borne
--                      anti-boucle : un job qui meurt à chaque reprise finit par
--                      échouer avec son code, au lieu de reprendre sans fin.
--   restart_blocked_by les outils que le tour interrompu avait DÉJÀ exécutés
--                      et qui ne font pas que lire (tableau de noms). Rejouer
--                      ce tour les referait : le job n'est pas repris, il
--                      échoue (`restart_after_side_effect`). NULL ailleurs.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS resumed_from_turn integer,
  ADD COLUMN IF NOT EXISTS restart_resumes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS restart_blocked_by jsonb;
