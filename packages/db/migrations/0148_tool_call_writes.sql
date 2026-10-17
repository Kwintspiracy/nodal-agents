-- CE QU'UN APPEL D'OUTIL A FAIT À CHAQUE FICHIER QU'IL VISAIT (issue #779).
--
-- `constated_writes` dit quels fichiers un RUN a livrés, une ligne par job,
-- par tour et par chemin, avec l'empreinte du contenu laissé. Elle ne dit pas
-- QUEL APPEL a écrit, et elle ne garde pas l'état d'AVANT. Or la question « ce
-- livrable a-t-il été écrit par l'outil du produit, ou par un script à sa
-- place ? » se répond par une chaîne de garde : l'état avant de chaque appel
-- doit être l'état après du précédent, et l'état final celui du dernier.
--
-- Une ligne = une cible FICHIER d'un appel qui a tourné, avec l'empreinte
-- (sha-256) du contenu avant et après l'appel. Elles sont déjà calculées par le
-- seam d'exécution (`snapshotFileTargets`, `fingerprint`) pour toute cible
-- fichier déclarée : cette table les range, liées à la ligne `tool_calls` de
-- l'appel (donc à son `seq`, la seule colonne d'ordre fiable).
--
-- Trois états, jamais deux : `absent` (le fichier n'existe pas), `file` (lu,
-- avec son empreinte), `unreadable` (il existe mais n'a pas pu être lu). Ranger
-- un refus de lecture dans « absent » ferait d'un échec de lecture une
-- écriture constatée (invariant #4). L'empreinte est présente si et seulement
-- si l'état est `file`.
--
-- D'OÙ VIENT L'EMPREINTE « APRÈS » (revue Reviewer A de #780, passe 1) :
-- `written`, l'empreinte des octets que l'outil a ÉCRITS, rapportée par
-- l'écrivain atomique du produit (`reportWrittenContent`, #505) ; `read`, une
-- relecture du disque après l'appel, quand l'outil n'a rien rapporté (un appel
-- qui n'a rien écrit). Une relecture peut voir le contenu d'un autre écrivain
-- passé juste après : elle n'est jamais une preuve, et la ligne le dit.
--
-- Ce que la table ne porte pas : ce qu'une commande (`run_command`), un
-- harnais de code ou un outil MCP écrit sans déclarer de cible fichier. Pour
-- eux, aucune ligne : leur écriture se voit à la rupture de la chaîne.
CREATE TABLE IF NOT EXISTS "tool_call_writes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tool_call_id" uuid NOT NULL REFERENCES "tool_calls"("id") ON DELETE CASCADE,
  "job_id" uuid NOT NULL REFERENCES "agent_jobs"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "before_kind" text NOT NULL,
  "before_sha256" text,
  "after_kind" text NOT NULL,
  "after_sha256" text,
  "after_source" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tool_call_writes_call_path_unique" UNIQUE ("tool_call_id", "path"),
  CONSTRAINT "tool_call_writes_before_kind_check"
    CHECK ("before_kind" IN ('absent', 'file', 'unreadable')),
  CONSTRAINT "tool_call_writes_after_kind_check"
    CHECK ("after_kind" IN ('absent', 'file', 'unreadable')),
  CONSTRAINT "tool_call_writes_before_sha_check"
    CHECK (("before_kind" = 'file') = ("before_sha256" IS NOT NULL)),
  CONSTRAINT "tool_call_writes_after_sha_check"
    CHECK (("after_kind" = 'file') = ("after_sha256" IS NOT NULL)),
  CONSTRAINT "tool_call_writes_after_source_check"
    CHECK ("after_source" IN ('written', 'read')),
  CONSTRAINT "tool_call_writes_written_is_file_check"
    CHECK ("after_source" <> 'written' OR "after_kind" = 'file')
);
CREATE INDEX IF NOT EXISTS "idx_tool_call_writes_job" ON "tool_call_writes" ("job_id");
CREATE INDEX IF NOT EXISTS "idx_tool_call_writes_call" ON "tool_call_writes" ("tool_call_id");
