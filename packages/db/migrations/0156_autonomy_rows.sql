-- UNE LIGNE D'AUTONOMIE PAR AGENT ET PAR OUTIL (#917).
--
-- Décision du propriétaire, 01/11/2026 : l'autonomie qu'un agent applique à un
-- outil est une ligne en base, toujours. L'onglet Autonomie montre cette
-- ligne, la porte applique cette ligne, et rien n'est calculé entre les deux.
--
-- Deux changements de forme, et aucune donnée touchée ici :
--
-- 1. Une ligne confinée à un dossier (« Approve for this project », #346) et la
--    ligne de l'outil pour le même agent doivent COEXISTER : la première vaut
--    dans ce dossier, la seconde partout ailleurs. La contrainte d'unicité
--    (espace, agent, outil) n'en laissait exister qu'une. Elle porte désormais
--    aussi le dossier, lu dans `condition_json` par une colonne générée — une
--    seule vérité, jamais recopiée à la main.
--
-- 2. `entities.autonomy_rows_written_at` : l'heure à laquelle les lignes
--    manquantes des agents EXISTANTS ont été écrites, avec la valeur que
--    l'écran montrait jusque-là. Ces valeurs se calculent depuis le registre
--    des outils, les skills, les connecteurs et les serveurs MCP de chaque
--    agent : du SQL ne les connaît pas. Le runner les écrit au démarrage
--    (`writeAutonomyRowsAtBoot`, @nodal-agents/orchestration), une fois par
--    espace, et pose cette heure. NULL : pas encore fait — l'état de TOUT
--    espace d'avant cette migration. Un espace créé après n'a rien d'avant à
--    reprendre : la colonne porte `now()` par défaut, posé APRÈS l'ajout pour
--    que les lignes existantes restent à NULL.
--
-- Rejouable (les tests qui rejouent les migrations depuis 0137 le font) :
-- chaque instruction tient sur une base qui l'a déjà reçue.
ALTER TABLE approval_rules
  ADD COLUMN IF NOT EXISTS condition_folder text
  GENERATED ALWAYS AS (COALESCE(condition_json->>'workspacePath', '')) STORED;

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS approval_rules_entity_agent_tool_unique;

ALTER TABLE approval_rules
  ADD CONSTRAINT approval_rules_entity_agent_tool_unique
  UNIQUE NULLS NOT DISTINCT (entity_id, agent_id, tool_name, condition_folder);

ALTER TABLE entities ADD COLUMN IF NOT EXISTS autonomy_rows_written_at timestamptz;
ALTER TABLE entities ALTER COLUMN autonomy_rows_written_at SET DEFAULT now();
