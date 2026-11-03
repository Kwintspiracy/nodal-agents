-- L'effort de raisonnement d'un tour DIT (#977) : le réglage « Reasoning when
-- spoken to » de l'agent.
--
-- 1. agents.spoken_reasoning_effort — l'effort d'un tour de chat dont la
--    réponse est entendue (`reply_rendering` 'spoken', 0157), sur l'échelle du
--    modèle principal : les mêmes valeurs que `reasoning_effort`, et NULL =
--    Auto comme lui. Le job que ce tour lance par `run_task`, les tours tapés
--    et la réflexion gardent `reasoning_effort`. Une valeur rangée, jamais
--    déduite de `reasoning_effort`.
--
-- 2. entities.spoken_reasoning_written_at — l'heure de la PREMIÈRE écriture
--    de ce réglage sur les agents qui existaient avant : `off` là où le modèle
--    de l'agent l'offre, NULL (Auto) ailleurs, décision de l'orchestrateur sur
--    la mesure du 03/11/2026. « Le modèle l'offre » se lit dans le catalogue
--    des modèles (TypeScript, @nodal-agents/shared) : du SQL ne le connaît
--    pas. Le runner l'écrit donc au démarrage (`writeFirstSpokenReasoningAtBoot`,
--    @nodal-agents/db), une fois par espace, et pose cette heure. NULL : pas
--    encore fait, l'état de TOUT espace d'avant cette migration. Un espace créé
--    après naît avec `now()` : ses agents reçoivent la valeur à leur création.
--    Le défaut est posé APRÈS l'ajout, pour que les lignes existantes restent
--    à NULL (même forme que 0156).
--
-- Rejouable : chaque instruction tient sur une base qui l'a déjà reçue.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS spoken_reasoning_effort text;
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN IF NOT EXISTS spoken_reasoning_written_at timestamptz;
--> statement-breakpoint
ALTER TABLE entities ALTER COLUMN spoken_reasoning_written_at SET DEFAULT now();
