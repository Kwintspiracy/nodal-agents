-- Les outils différés qu'un job a chargés, dans l'ordre de leur chargement
-- (#612, revue de la PR #616).
--
-- Un job n'envoie au modèle que les schémas de ses outils `eager`, puis de
-- ceux qu'il a chargés (par `load_tools` ou par un appel direct). Ce qui a été
-- chargé ne peut pas dépendre de la transcription : la compaction du contexte
-- remplace l'entrée d'un vieil appel volumineux par un marqueur, et la liste
-- des noms passés à `load_tools` disparaissait avec elle. La liste vit donc
-- sur la ligne du job, relue à chaque reprise (approbation, délégation,
-- redémarrage), et ne fait que croître.
--
-- NULL : job antérieur à cette colonne, ou qui n'a rien chargé.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS loaded_tools text[];
