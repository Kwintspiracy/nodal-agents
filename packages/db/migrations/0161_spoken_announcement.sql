-- Ce que l'agent a DIT quand un job lancé par la voix a fini (#967).
--
-- agent_jobs.spoken_announcement — l'annonce, écrite par l'agent pour
-- l'oreille, à partir de la demande et du résultat : le résultat se lit (il
-- reste tel quel dans le fil et dans Runs), l'annonce s'entend. NULL : rien
-- n'a été dit, soit toute ligne déjà écrite.
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS spoken_announcement text;
