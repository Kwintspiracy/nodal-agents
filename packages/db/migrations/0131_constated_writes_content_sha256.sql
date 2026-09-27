-- content_sha256 — l'empreinte du contenu qu'une écriture constatée a laissé
-- sur le disque (revue Codex de #505).
--
-- La porte d'écrasement du dossier partagé laisse un run réécrire le fichier
-- qu'il a lui-même produit. Le dernier constat en base ne suffit pas à le
-- prouver : une édition faite hors de Nodal ne laisse aucune ligne, et l'ordre
-- d'insertion des constats n'est pas l'ordre des écritures. Seule l'empreinte
-- du contenu, comparée à celle du disque au moment de réécrire, dit si le
-- fichier est encore celui que ce run a écrit.
--
-- NULL pour une suppression, un fichier illisible, et toutes les lignes
-- écrites avant cette colonne : aucune de ces lignes n'accorde la propriété.
ALTER TABLE constated_writes
  ADD COLUMN IF NOT EXISTS content_sha256 text;

-- La porte cherche par chemin, tous jobs confondus : sans index, un parcours
-- complet de la table à chaque réécriture d'un fichier partagé.
CREATE INDEX IF NOT EXISTS idx_constated_writes_path_created
  ON constated_writes (path, created_at DESC);
