-- 0085 — un dossier de developpement se COCHE, il ne se devine pas.
--
-- L'onglet Code doit montrer le travail de developpement, et rien d'autre.
-- Quatre definitions ont ete essayees et ecartees, toutes parce qu'elles
-- DEVINAIENT :
--
--   * la nature des fichiers edites (extensions) : « une exclusion par langage
--     ratera tot ou tard du vrai code » — un .json de mock-data EST du code.
--     Et le coffre Obsidian qualifiait quand meme, a cause de vrais .py ecrits
--     dedans en juillet ;
--   * le skill porte par l'agent : ne marche que si l'utilisateur emploie NOS
--     skills, jamais les siens ni ceux du catalogue communautaire ;
--   * la structure du dossier (package.json, .git…) : symetrique du premier
--     echec — « on va 100 % avoir des faux positifs », un depot clone ou un
--     theme jamais touche en porte un ;
--   * une case sur l'AGENT : repond au « qui », pas au « ou ». Un agent qui
--     code le matin et range le coffre l'apres-midi y ferait entrer le coffre.
--
-- D'ou cette colonne : la designation porte sur le DOSSIER, et elle est
-- explicite. La case definit un PERIMETRE, pas un projet — cocher `Dev` ne
-- fait pas de `Dev` un projet, ses sous-dossiers en sont.
--
-- Aucun backfill : cocher un dossier a la place du proprietaire serait une
-- devinette de plus, exactement ce que ce lot supprime. L'onglet Code nomme le
-- geste tant qu'aucun dossier n'est coche.
ALTER TABLE agent_workspaces
  ADD COLUMN IF NOT EXISTS is_dev_folder boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- La derivation des projets lit les dossiers coches a chaque job et a chaque
-- chargement de l'onglet : un index partiel garde ces lectures triviales.
CREATE INDEX IF NOT EXISTS idx_agent_workspaces_dev_folder
  ON agent_workspaces (entity_id)
  WHERE is_dev_folder;
