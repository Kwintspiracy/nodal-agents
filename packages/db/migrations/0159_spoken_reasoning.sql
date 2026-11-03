-- L'effort de raisonnement d'un tour DIT (#977) : le réglage « Reasoning when
-- spoken to » de l'agent.
--
-- agents.spoken_reasoning_effort — l'effort d'un tour de chat dont la réponse
-- est entendue (`reply_rendering` 'spoken', 0157), sur l'échelle du modèle
-- principal : les mêmes valeurs que `reasoning_effort`, et NULL = Auto comme
-- lui. Le job que ce tour lance par `run_task`, les tours tapés et la
-- réflexion gardent `reasoning_effort`. Une valeur rangée, jamais déduite de
-- `reasoning_effort`.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS spoken_reasoning_effort text;
