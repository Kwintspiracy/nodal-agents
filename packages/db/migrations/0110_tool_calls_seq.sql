-- L'ORDRE D'ÉCRITURE des appels d'outils (#124, revue passe 2).
--
-- Une ligne de `tool_calls` n'avait aucune clé monotone : `id` est un uuid
-- aléatoire, `turn` est le même pour tous les appels d'un tour, et `created_at`
-- peut porter la même valeur pour deux insertions rapprochées — a fortiori pour
-- la pré-passe de lectures, qui exécute plusieurs outils en parallèle. « La
-- dernière ligne » n'était donc pas déterminable, et une règle qui en dépend
-- (le verdict de revue est-il le dernier geste du job ?) tirait à pile ou face.
--
-- `seq` est cet ordre : une séquence, une valeur par insertion, croissante.
--
-- CE QUE CETTE MIGRATION COÛTE, ET CE QU'ELLE NE GARANTIT PAS (revue passe 3) :
--
--  1. `ADD COLUMN bigserial` numérote les lignes DÉJÀ ÉCRITES dans l'ordre
--     PHYSIQUE de la table, pas dans l'ordre chronologique. Pour un job à cheval
--     sur la migration, l'ordre de ses vieilles lignes peut donc être faux. Le
--     risque est assumé, et borné : la règle qui lit `seq` ne s'applique qu'aux
--     jobs qui se terminent APRÈS la migration, les jobs déjà finis ne sont
--     jamais relus, et toute ligne écrite après la migration reçoit un numéro
--     supérieur à tout le remplissage — le tour final d'un job commencé avant
--     est donc quand même ordonné correctement.
--  2. L'`ALTER` RÉÉCRIT LA TABLE ENTIÈRE sous verrou : sur une grande
--     `tool_calls`, la mise à jour prend le temps d'une réécriture complète, et
--     le runner attend pendant ce temps. C'est une base locale, mono-poste ; le
--     prix est payé une fois.
ALTER TABLE "tool_calls" ADD COLUMN IF NOT EXISTS "seq" bigserial;

CREATE INDEX IF NOT EXISTS "idx_tool_calls_job_seq" ON "tool_calls" ("job_id", "seq" DESC);
