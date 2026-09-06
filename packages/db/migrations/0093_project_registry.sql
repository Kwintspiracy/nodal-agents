-- 0093 — le REGISTRE des projets (plan « De la maquette au produit », P5).
--
-- Jusqu'ici, une ligne `code_projects` n'était que de la COMPTABILITÉ : elle
-- naissait d'un renommage, d'un masquage, d'une configuration de preuve, ou
-- toute seule quand une écriture atterrissait dans une racine dérivée
-- (bumpProjectEpoch). Elle ne disait pas « ceci est un projet », elle disait
-- « quelqu'un a touché ce dossier ».
--
-- P5 a besoin de l'autre chose : un projet DÉCLARÉ, qu'un écran peut lister,
-- auquel un travail se rattache. Plutôt qu'une seconde table qui aurait fait
-- deux vérités sur l'identité d'un dossier (`project_key` existe pour empêcher
-- exactement cela), c'est la MÊME ligne, avec un discriminant : `registered_at`
-- NULL = comptabilité, NOT NULL = projet enregistré. Rien de l'existant ne
-- change de comportement — l'onglet Code et la vérification continuent de lire
-- `display_name`, `hidden` et `verify_*` par clé, sans jamais regarder cette
-- colonne.
--
-- `agent_jobs.project_id` est l'autre moitié : le travail produit DANS un
-- projet enregistré porte son identité. Posé une seule fois, au premier
-- rattachement (le `WHERE project_id IS NULL` de attach.ts fait la règle « le
-- premier gagne »), et SET NULL si le projet est désinscrit — l'historique d'un
-- job ne disparaît jamais avec le projet.
ALTER TABLE code_projects
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'code';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_projects_kind_check') THEN
    ALTER TABLE code_projects
      ADD CONSTRAINT code_projects_kind_check CHECK (kind IN ('code','documents'));
  END IF;
END;
$$;
--> statement-breakpoint
-- L'agent responsable : celui dont le terrain contient le projet. SET NULL —
-- supprimer un agent ne doit pas emporter le projet, seulement le lien.
ALTER TABLE code_projects
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
--> statement-breakpoint
-- LE discriminant. NULL = ligne de comptabilité, pas un projet.
ALTER TABLE code_projects
  ADD COLUMN IF NOT EXISTS registered_at timestamptz;
--> statement-breakpoint
-- D'où vient la déclaration : l'écran des espaces, ou une conversation (P6).
ALTER TABLE code_projects
  ADD COLUMN IF NOT EXISTS registered_from text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_projects_registered_from_check') THEN
    ALTER TABLE code_projects
      ADD CONSTRAINT code_projects_registered_from_check
      CHECK (registered_from IS NULL OR registered_from IN ('spaces','conversation'));
  END IF;
END;
$$;
--> statement-breakpoint
-- Le job qui l'a déclaré, quand la déclaration vient d'une conversation.
ALTER TABLE code_projects
  ADD COLUMN IF NOT EXISTS registered_job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Index PARTIEL : la liste des projets ne lit que les lignes enregistrées, qui
-- resteront minoritaires devant la comptabilité produite par les écritures.
CREATE INDEX IF NOT EXISTS idx_code_projects_registered
  ON code_projects(entity_id) WHERE registered_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES code_projects(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_jobs_project
  ON agent_jobs(project_id) WHERE project_id IS NOT NULL;
