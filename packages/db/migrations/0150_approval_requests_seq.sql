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
-- COMMENT LES LIGNES DÉJÀ ÉCRITES SONT NUMÉROTÉES, ET CE QUE ÇA COÛTE (revue
-- passe 1 de #803). Drizzle applique toutes les migrations en attente dans UNE
-- transaction : le premier `ALTER` garde son verrou exclusif jusqu'à la fin, donc
-- le coût de cette migration est le temps pendant lequel la table est fermée aux
-- écritures. Mesuré sur un vrai Postgres, une insertion concurrente attendant
-- toute la migration :
--   - `UPDATE … SET seq = row_number() OVER (ORDER BY requested_at, id)` :
--     100 000 lignes ≈ 1,7 s ; 1 000 000 lignes ≈ 30 s (29,4 s d'`UPDATE`, qui
--     réécrit chaque ligne et met à jour les quatre index de la table) ;
--   - `ALTER COLUMN seq TYPE bigint USING (…requested_at…)`, ci-dessous :
--     1 000 000 lignes ≈ 4,1 s (une réécriture de la table, les index reconstruits
--     une fois) ; SET NOT NULL 0,07 s ; index 0,3 s.
-- C'est la seconde forme qui est retenue.
--
-- Prix de cette forme : une ligne déjà écrite reçoit les MICROSECONDES de
-- `requested_at` (époque Unix), pas un rang 1, 2, 3… Leur ordre relatif est celui
-- de l'heure ; deux lignes déjà écrites de la même microseconde restent sans
-- ordre entre elles (elles ne l'avaient pas non plus avant). Une ligne écrite
-- après la migration reçoit un numéro de la séquence, qui repart au-dessus du
-- plus grand numéro du remplissage : toute ligne neuve est après toute ligne
-- ancienne. Une `requested_at` NULL vaut 0 : la plus ancienne.
--
-- Le nom de la séquence est celui que `bigserial` donnerait
-- (`approval_requests_seq_seq`), pour que le schéma Drizzle et la base disent la
-- même chose.
CREATE SEQUENCE IF NOT EXISTS "approval_requests_seq_seq";

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "seq" bigint;

ALTER TABLE "approval_requests" ALTER COLUMN "seq" TYPE bigint
  USING (COALESCE(extract(epoch from "requested_at") * 1000000, 0))::bigint;

SELECT setval(
  'approval_requests_seq_seq',
  COALESCE((SELECT max("seq") FROM "approval_requests"), 0) + 1,
  false
);

ALTER TABLE "approval_requests" ALTER COLUMN "seq" SET DEFAULT nextval('approval_requests_seq_seq');
ALTER TABLE "approval_requests" ALTER COLUMN "seq" SET NOT NULL;
ALTER SEQUENCE "approval_requests_seq_seq" OWNED BY "approval_requests"."seq";

CREATE INDEX IF NOT EXISTS "idx_approval_requests_seq" ON "approval_requests" ("seq");
