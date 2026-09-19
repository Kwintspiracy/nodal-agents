-- LES FICHIERS LIVRÉS D'UN RUN, CONSTATÉS (issue #199).
--
-- La liste que le bloc Files montre venait, jusqu'ici, d'une relecture des
-- lignes `tool_calls` : ce qu'un outil avait NOMMÉ. Un `run_command` qui écrit
-- dix fichiers sans les nommer n'y paraissait pas. Cette table porte le constat
-- lui-même, et surtout COMMENT il a été pris :
--
--   git  — le dossier du projet est un dépôt : `git status --porcelain` lu
--          avant le run et après, le delta est la liste. Elle voit ce qu'un
--          shell écrit sans le dire.
--   disk — pas de dépôt (ou git n'a pas répondu) : la règle de #196, les
--          fichiers nommés par les outils et le harnais, relus sur le disque.
--
-- Les deux mots sont dans la donnée parce que l'écran doit les DIRE : lire une
-- liste « disque » comme une liste « git » ferait croire complet un constat qui
-- ne l'est pas (invariant #4).
--
-- L'unicité est (job, tour, chemin) : un fichier écrit trois fois dans le même
-- tour est un fichier livré, pas trois lignes.
CREATE TABLE IF NOT EXISTS "constated_writes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_id" uuid NOT NULL REFERENCES "agent_jobs"("id") ON DELETE CASCADE,
  "turn" integer NOT NULL,
  "path" text NOT NULL,
  "change_kind" text NOT NULL,
  "constated_by" text NOT NULL,
  "renamed_from" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "constated_writes_job_turn_path_unique" UNIQUE ("job_id", "turn", "path"),
  CONSTRAINT "constated_writes_change_kind_check"
    CHECK ("change_kind" IN ('added', 'modified', 'deleted', 'renamed')),
  CONSTRAINT "constated_writes_constated_by_check"
    CHECK ("constated_by" IN ('git', 'disk'))
);

CREATE INDEX IF NOT EXISTS "idx_constated_writes_job" ON "constated_writes" ("job_id");
