-- removed — un appel de CE job a-t-il retiré ce livrable du disque ? (issue #916)
--
-- Toute cible de mutation devient une ligne d'état, et la preuve d'un document
-- commence par `exists`. La source d'un `file_move`, un fichier qu'un
-- `run_command` efface : ce que le job a RETIRÉ était prouvé comme ce qu'il
-- devait avoir PRODUIT, et le run finissait rouge sur « not found » après un
-- déplacement réussi.
--
-- Posée par le seam d'exécution quand l'adresse du livrable était là avant un
-- appel du job et n'y est plus après (`present -> absent`), levée quand un
-- appel du job la fait revenir (`absent -> present`). Rien d'autre ne la pose :
-- un fichier qui disparaît HORS des appels du job reste un livrable qui manque,
-- donc rouge. La preuve d'une ligne `removed` (non promise) constate l'ABSENCE.
--
-- Défaut `false` : aucune ligne déjà écrite n'a été observée retirée.
ALTER TABLE job_deliverable_verification_state
  ADD COLUMN IF NOT EXISTS removed boolean NOT NULL DEFAULT false;
