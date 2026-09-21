-- LES DOSSIERS ÉCARTÉS D'UN ESPACE (issue #385).
--
-- #371 a donné « Forget » : la ligne `code_projects` d'un projet masqué quitte
-- la base, l'historique des runs et des conversations reste, le dossier n'est
-- pas touché. Mais la page Projects ne liste pas que le registre : elle liste
-- aussi les dossiers DÉDUITS des écritures passées des agents. Un projet oublié
-- dont le dossier portait de telles écritures revenait donc dans la liste,
-- marqué « Detected », avec Register et Hide offerts de nouveau. Oublier ne
-- tenait pas.
--
-- On ne peut pas régler cela dans `code_projects` : une ligne qui y resterait
-- pour dire « ce dossier est écarté » serait exactement la ligne de masquage
-- que « Forget » vient de supprimer, et le mot « oublier » redeviendrait un
-- synonyme de « masquer ».
--
-- D'où cette table, qui porte UN fait et un seul : quelqu'un a écarté ce
-- dossier de cet espace, à cette date. La détection le saute, et « Detect
-- again » supprime la ligne.
--
-- L'UNICITÉ EST SUR LA CLÉ, pas sur le chemin : `project_key` est la même
-- identité canonique que le registre porte depuis 0088. Sous Windows, le même
-- dossier remonte avec des casses différentes selon la session ; une unicité
-- sur `project_path` laisserait deux exclusions du même dossier coexister, et
-- la détection n'en lirait qu'une. `project_path` reste à côté pour l'écran.
CREATE TABLE IF NOT EXISTS "excluded_project_paths" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "project_path" text NOT NULL,
  "project_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "excluded_project_paths_entity_key_unique" UNIQUE ("entity_id", "project_key")
);

-- L'écran demande TOUS les dossiers écartés d'un espace, à chaque rendu de la
-- page Projects — jamais un chemin précis. C'est cette lecture-là qui est
-- indexée.
CREATE INDEX IF NOT EXISTS "idx_excluded_project_paths_entity"
  ON "excluded_project_paths" ("entity_id");
