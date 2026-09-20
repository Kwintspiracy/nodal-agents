-- COMBIEN DE TEMPS LE FILET A MIS À PHOTOGRAPHIER (issue #261).
--
-- Le filet sous les écritures photographie chaque dossier avant le premier
-- outil mutant d'un tour, et `git add` y est borné à 30 secondes. Le soir du
-- 19/09/2026, un dossier partagé monté à 3,3 Go a dépassé cette borne : les
-- agents se sont vu refuser toute écriture, et ils ont cherché une panne du
-- dossier pendant des heures. L'issue #245 a fait dire au refus sa cause et
-- ses chiffres. Celle-ci fait voir la montée AVANT le refus.
--
-- Pour cela il faut une durée, et la durée n'existait NULLE PART : elle ne
-- vivait que sur le chemin d'ÉCHEC, en mémoire, le temps de rendre la phrase
-- du refus (`elapsedMs` de packages/checkpoints/src/failure.ts). Une photo qui
-- RÉUSSIT en 24 secondes ne laissait aucune trace — c'est-à-dire exactement le
-- cas qu'il faut voir venir.
--
-- Voici la colonne : les millisecondes qu'a pris la photo qui a produit CETTE
-- ligne. Sur `job_checkpoints` et pas ailleurs, parce que c'est la seule table
-- qui relie une photo à un dossier, un travail et un tour — l'écran n'a plus
-- qu'à lire la plus récente d'un dossier.
--
-- MESURÉE, jamais estimée : l'horloge est prise autour du seul appel de
-- `snapshot`, aux deux endroits qui photographient (le seam de
-- `packages/tools` et le harnais CLI du runner).
--
-- NULLABLE ET SANS DÉFAUT : les lignes déjà en base n'ont pas été chronométrées
-- et ne recevront pas une durée inventée. NULL veut dire « pas mesurée », et
-- l'écran le DIT plutôt que d'afficher un zéro qui se lirait « instantané »
-- (invariant #4).
--
-- Pas de contrainte de borne supérieure : une photo peut légitimement durer
-- plus longtemps que le budget de `git add`, puisque la durée couvre aussi ce
-- que `snapshot` fait autour. Une borne inventée refuserait la ligne au moment
-- précis où sa valeur est la plus intéressante.
ALTER TABLE "job_checkpoints" ADD COLUMN IF NOT EXISTS "snapshot_ms" integer;

ALTER TABLE "job_checkpoints" DROP CONSTRAINT IF EXISTS "job_checkpoints_snapshot_ms_check";

ALTER TABLE "job_checkpoints" ADD CONSTRAINT "job_checkpoints_snapshot_ms_check"
  CHECK ("snapshot_ms" IS NULL OR "snapshot_ms" >= 0);

-- L'ÉCRAN DEMANDE « LA DERNIÈRE PHOTO DE CET ESPACE », et rien d'autre : un
-- `ORDER BY taken_at DESC LIMIT 1` par espace, joint sur le job.
--
-- Sans cet index, le planificateur n'a le choix qu'entre trier toutes les
-- photos de l'entité et parcourir la table à l'envers en sondant `agent_jobs`.
-- Le second dégénère précisément pour un espace SILENCIEUX — celui dont la
-- dernière photo est la plus ancienne, donc la plus loin dans le parcours
-- (revue C, passe 2). C'est le cas que l'écran doit servir vite, puisque c'est
-- celui qu'on n'ouvre que pour voir s'il a grossi.
CREATE INDEX IF NOT EXISTS "idx_job_checkpoints_taken_at"
  ON "job_checkpoints" ("taken_at" DESC);
