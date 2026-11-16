-- `render_pdf` DÉMARRE AVEC LA DÉCISION DÉJÀ PRISE SUR `file_write` (#1082).
--
-- `render_pdf` est un nouvel outil d'écriture, toujours donné : il écrit un
-- PDF dans les dossiers de l'agent, par le périmètre et la porte
-- d'écrasement de `file_write`. Sans ligne, le rédacteur des réglages
-- d'autonomie (#917) lui en écrirait une au démarrage d'après le modèle de
-- l'espace : un agent dont le propriétaire a BLOQUÉ `file_write` (un relecteur
-- en lecture seule) pourrait, du jour au lendemain, écrire des PDF. Un
-- élargissement silencieux.
--
-- La forme générale est celle de `file_move` (0154) : chaque règle sur
-- `file_write` — quelle que soit son action (block, require_approval,
-- auto_approve), sa portée (un agent, ou tous les agents de l'espace quand
-- `agent_id` est nul) et sa condition (un dossier) — donne la même règle sur
-- `render_pdf`. Le propriétaire a décidé de ce que cet agent peut écrire ;
-- rendre un PDF est écrire.
--
-- Idempotente, et elle n'écrase rien : une règle `render_pdf` déjà posée pour
-- le même (espace, agent) est gardée telle quelle (la contrainte d'unicité
-- traite deux `agent_id` nuls comme égaux).
INSERT INTO approval_rules (entity_id, agent_id, tool_name, action, condition_json)
SELECT entity_id, agent_id, 'render_pdf', action, condition_json
FROM approval_rules
WHERE tool_name = 'file_write'
ON CONFLICT ON CONSTRAINT approval_rules_entity_agent_tool_unique DO NOTHING;
