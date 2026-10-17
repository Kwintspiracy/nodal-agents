-- CE QU'UN APPEL D'OUTIL A LU (le pendant de `tool_call_writes`, 0148).
--
-- Le banc d'essai doit pouvoir dire qu'un outil du produit a lu LE fichier
-- qu'il a posé, et pas une copie : le chemin qu'un appel donne ne suffit pas
-- (une copie sous un dossier dont le chemin finit pareil), et le reconstruire
-- après coup avec les dossiers de l'agent au moment du jugement se trompe
-- (revue de #777, passes 3 et 4). La plateforme sait, au moment de la lecture,
-- quel fichier réel elle a ouvert et quels octets elle a lus : elle le range.
--
-- Une ligne = un fichier qu'un appel a lu avec succès : son chemin RÉEL
-- (lien symbolique ou jonction résolus, barres obliques, la même forme que
-- `tool_call_writes.path`) et l'empreinte sha-256 des OCTETS LUS, rapportée
-- par le lecteur lui-même (`reportReadContent`), jamais une relecture.
-- Une lecture qui échoue (fichier absent, trop gros, refusé) ne laisse aucune
-- ligne : rien n'a été lu.
--
-- Ce que la table ne porte pas : ce qu'une commande, un harnais de code ou un
-- outil MCP lit. La plateforme n'ouvre pas ces fichiers elle-même ; elle ne
-- peut pas dire ce qui a été lu, et elle n'invente rien.
CREATE TABLE IF NOT EXISTS "tool_call_reads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tool_call_id" uuid NOT NULL REFERENCES "tool_calls"("id") ON DELETE CASCADE,
  "job_id" uuid NOT NULL REFERENCES "agent_jobs"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tool_call_reads_call_path_unique" UNIQUE ("tool_call_id", "path"),
  CONSTRAINT "tool_call_reads_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS "idx_tool_call_reads_job" ON "tool_call_reads" ("job_id");
CREATE INDEX IF NOT EXISTS "idx_tool_call_reads_path" ON "tool_call_reads" ("path");
