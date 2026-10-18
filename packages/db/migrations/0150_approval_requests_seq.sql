-- L'ORDRE DE CRÉATION des demandes d'approbation (#801).
--
-- Une ligne de `approval_requests` n'avait aucune clé monotone : `id` est un uuid
-- aléatoire et `requested_at` a la précision de la milliseconde. Deux demandes
-- créées coup sur coup (deux élicitations MCP d'une même pré-passe, deux runs)
-- portaient donc la même heure, et leur ordre — sur /approvals, dans le fil d'un
-- job, à la reprise d'un run — changeait d'un rafraîchissement à l'autre.
-- `tool_calls.seq` ne pouvait pas servir : la ligne `tool_calls` d'un appel
-- retenu n'existe pas encore quand sa demande est posée.
--
-- `seq` est cet ordre : une séquence, une valeur par insertion, croissante.
--
-- Les lignes DÉJÀ écrites sont numérotées dans l'ordre (requested_at, id), pas
-- dans l'ordre physique de la table : c'est le meilleur ordre que l'on ait, et
-- seules les égalités d'heure y restent arbitraires. Toute ligne écrite après la
-- migration reçoit un numéro supérieur à tout le remplissage. Le nom de la
-- séquence est celui que `bigserial` donnerait (`approval_requests_seq_seq`),
-- pour que le schéma Drizzle et la base disent la même chose.
CREATE SEQUENCE IF NOT EXISTS "approval_requests_seq_seq";

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "seq" bigint;

UPDATE "approval_requests" AS a
SET "seq" = n.rn
FROM (
  SELECT "id", row_number() OVER (ORDER BY "requested_at", "id") AS rn
  FROM "approval_requests"
) AS n
WHERE a."id" = n."id" AND a."seq" IS NULL;

SELECT setval(
  'approval_requests_seq_seq',
  COALESCE((SELECT max("seq") FROM "approval_requests"), 0) + 1,
  false
);

ALTER TABLE "approval_requests" ALTER COLUMN "seq" SET DEFAULT nextval('approval_requests_seq_seq');
ALTER TABLE "approval_requests" ALTER COLUMN "seq" SET NOT NULL;
ALTER SEQUENCE "approval_requests_seq_seq" OWNED BY "approval_requests"."seq";

CREATE INDEX IF NOT EXISTS "idx_approval_requests_seq" ON "approval_requests" ("seq");
