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

-- removed_size — la taille de l'adresse vue AVANT l'appel qui l'a retirée
-- (revue A de la PR #919, passe 3). La finalisation cherche le contenu retiré
-- ailleurs avant de le déclarer perdu ; seul un fichier de cette taille peut
-- le porter, et c'est elle qui empêche un brouillon de 2 Ko de faire lire un
-- rendu de 300 Mo. NULL quand la ligne n'est pas retirée.
ALTER TABLE job_deliverable_verification_state
  ADD COLUMN IF NOT EXISTS removed_size bigint;

-- constated_writes.observed_sha256 — l'empreinte du contenu que le CONSTAT a
-- lu sur le disque APRÈS l'appel (revue A de la PR #919, passes 4 et 5), pour
-- toute source de constat : la cible nommée ou le fichier de harnais
-- (`constatSurDisque`), git, l'instantané de checkpoint — chacun la calcule
-- déjà pour décider qu'il y a eu écriture. Jamais une empreinte prise avant.
-- Elle dit QUEL contenu est là, jamais qu'un job l'a écrit : la porte
-- d'écrasement continue de ne lire que `content_sha256`. NULL quand le
-- constat n'a rien pu lire.
ALTER TABLE constated_writes
  ADD COLUMN IF NOT EXISTS observed_sha256 text;
