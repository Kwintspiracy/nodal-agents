-- 0086 — l'onglet Code cesse de DEVINER, et l'utilisateur reprend la main.
--
-- Six definitions ont ete essayees pour savoir ce qui merite d'apparaitre dans
-- l'onglet Code. Toutes ecartees, toutes pour la meme raison : elles
-- decidaient a la place du proprietaire, sur un indice indirect.
--
--   1. l'extension des fichiers        « une exclusion par langage ratera tot
--                                        ou tard du vrai code »
--   2. le skill porte par l'agent      ne marche qu'avec NOS skills
--   3. la structure du dossier         « on va 100 % avoir des faux positifs »
--   4. une case sur l'agent            repond au « qui », pas au « ou »
--   5. une case sur le dossier         (0085) il faut encore deviner si le
--                                        dossier coche EST un projet ou en
--                                        CONTIENT
--   6. une nature devinee par dossier  liste sans fin : Obsidian, ComfyUI,
--                                        Blender, Unity, Godot, un CMS…
--
-- Decision Quentin (26/08) : ne rien deviner. L'onglet montre les dossiers ou
-- les agents ont travaille, et le proprietaire dispose des deux seuls gestes
-- que le produit ne peut pas poser a sa place : RENOMMER ce qui porte mal son
-- nom, MASQUER ce qu'il ne veut plus voir.
--
-- D'ou cette migration :
--   * `agent_workspaces.is_dev_folder` disparait — le filtrage n'existe plus ;
--   * `code_project_archives` devient `code_projects`, qui porte desormais les
--     DEUX gestes au lieu du seul masquage.
--
-- « Masquer » plutot qu'« archiver » : le dossier n'est jamais touche, rien
-- n'est fini ni range definitivement — c'est un choix d'affichage, et le mot
-- doit le dire. Le masquage retire aussi le projet du contexte injecte aux
-- agents, ce que l'archivage ne faisait pas : un projet range n'a pas a etre
-- annonce dans le prompt de tout le monde.
ALTER TABLE agent_workspaces DROP COLUMN IF EXISTS is_dev_folder;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS code_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  -- Chemin absolu du projet, slash-normalise (la forme que rend la derivation).
  project_path text NOT NULL,
  -- Nom choisi par le proprietaire. NULL = on affiche le nom du dossier.
  display_name text,
  -- Masque de la liste ET du contexte des agents.
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, project_path)
);
--> statement-breakpoint
-- Les projets deja archives restent masques : le geste avait ete pose, il est
-- conserve tel quel.
INSERT INTO code_projects (entity_id, project_path, hidden, created_at)
SELECT entity_id, project_path, true, archived_at
FROM code_project_archives
ON CONFLICT (entity_id, project_path) DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS code_project_archives;
--> statement-breakpoint
-- La liste est lue a chaque chargement de l'onglet ET a chaque job (le contexte
-- des agents doit savoir ce qui est masque) : l'index garde ces lectures
-- triviales.
CREATE INDEX IF NOT EXISTS idx_code_projects_entity ON code_projects (entity_id);
