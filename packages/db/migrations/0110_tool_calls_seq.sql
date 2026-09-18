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
ALTER TABLE "tool_calls" ADD COLUMN IF NOT EXISTS "seq" bigserial;

CREATE INDEX IF NOT EXISTS "idx_tool_calls_job_seq" ON "tool_calls" ("job_id", "seq" DESC);
