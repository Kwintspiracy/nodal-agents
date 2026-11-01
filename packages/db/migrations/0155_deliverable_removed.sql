-- removed / moved_to_key — un appel de CE job a-t-il RETIRÉ ce livrable du
-- disque, et l'avait-il DÉCLARÉ déplacé ? (issue #916)
--
-- Toute cible de mutation devient une ligne d'état, et la preuve d'un document
-- commence par `exists`. La source d'un `file_move` réussi était donc prouvée
-- comme un livrable qui devait exister : rouge sur « not found » après un
-- déplacement réussi.
--
-- `removed` est posé par le seam d'exécution quand l'adresse était là avant un
-- appel du job et n'y est plus après ; levé quand un appel du job la fait
-- revenir. `moved_to_key` est la clé de la destination que cet appel avait
-- DÉCLARÉE (`MutationTarget.movesTo`), quand elle retrouve une ligne d'état du
-- même job : alors seulement l'absence est attendue, et la destination est
-- jugée par sa propre ligne. Tout autre retrait garde `exists`, rouge.
--
-- Défaut `false` / NULL : aucune ligne déjà écrite n'a été observée retirée.
ALTER TABLE job_deliverable_verification_state
  ADD COLUMN IF NOT EXISTS removed boolean NOT NULL DEFAULT false;
ALTER TABLE job_deliverable_verification_state
  ADD COLUMN IF NOT EXISTS moved_to_key text;
