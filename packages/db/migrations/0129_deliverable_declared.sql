-- declared — l'AGENT a-t-il nommé ce fichier comme un livrable de son run,
-- dans `return_result.deliverables` ? (issue #509)
--
-- La preuve ne connaissait que les fichiers écrits par un outil de fichiers.
-- Un fichier qu'une COMMANDE devait produire (un rendu, un build, un export)
-- n'était vérifié par rien : le 25/09, un run a fini `completed` avec une
-- preuve verte sur les sources d'un projet Remotion, alors que la vidéo qu'il
-- disait livrée n'existait pas.
--
-- Un livrable déclaré passe par la MÊME ligne d'état et la MÊME preuve que les
-- autres ; cette colonne dit seulement que l'agent l'a promis, et c'est elle
-- qui fait d'une preuve rouge qui survit à la réparation un ÉCHEC du run —
-- les livrables non déclarés restent observés, comme avant.
--
-- Défaut `false` : aucune ligne déjà écrite n'a été déclarée par personne.
ALTER TABLE job_deliverable_verification_state
  ADD COLUMN IF NOT EXISTS declared boolean NOT NULL DEFAULT false;
