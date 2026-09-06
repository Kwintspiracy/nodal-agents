-- 0099 — l'instantané d'un tour, en base (P11, plan « De la maquette au
-- produit »).
--
-- POURQUOI CETTE TABLE EXISTE. Le filet sous les écritures (packages/checkpoints)
-- prend déjà une photo du dossier avant chaque tour qui écrit, et la range dans
-- un git fantôme sous ~/.nodalai/checkpoints. Mais le sha de cette photo ne
-- vivait QUE dans une ligne de journal console : personne, une heure plus tard,
-- ne pouvait dire « l'état d'avant du tour 7 de ce travail, c'était ce
-- commit-là ». Sans ce lien, la carte « 12 fichiers » du fil ne peut pas
-- montrer ce qui a changé — elle n'a rien à comparer.
--
-- POURQUOI (job, turn, workspace) EST LA CLÉ. Un tour est UNE unité de travail
-- et prend UN instantané par dossier attaché (voir takeCheckpointForTurn) : la
-- deuxième, la troisième écriture du même tour retombent sur la même photo.
-- L'unicité dit exactement cela, et rend l'insertion rejouable — le seam pose
-- la ligne à chaque écriture et laisse la base trancher (ON CONFLICT DO
-- NOTHING) plutôt que de tenir un mémo de plus.
--
-- POURQUOI LE DOSSIER EST DU TEXTE, PAS UNE RÉFÉRENCE. Le dossier est celui que
-- le seam connaît au moment de la photo : un chemin absolu sur la machine.
-- `agent_workspaces` peut être renommé, détaché, repointé ; l'instantané, lui,
-- est indexé dans le magasin par le hachage de CE chemin-là. Une clé étrangère
-- ferait mentir la ligne dès le premier détachement.
--
-- CASCADE sur le travail : une ligne d'instantané sans travail n'a plus de
-- lecteur. L'instantané lui-même survit dans le magasin — il est effacé par la
-- rétention du magasin, jamais par la base.
CREATE TABLE IF NOT EXISTS job_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  turn integer NOT NULL,
  workspace text NOT NULL,
  sha text NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_checkpoints_job_turn_workspace_unique UNIQUE (job_id, turn, workspace)
);
--> statement-breakpoint
-- La lecture du fil : tous les instantanés d'un travail, pour trouver l'état
-- d'avant d'un tour et celui du tour SUIVANT (la borne haute du diff).
CREATE INDEX IF NOT EXISTS idx_job_checkpoints_job ON job_checkpoints (job_id);
