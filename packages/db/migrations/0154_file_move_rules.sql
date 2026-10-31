-- `file_move` DÉMARRE AVEC LA DÉCISION DÉJÀ PRISE SUR `file_write` (#879).
--
-- `file_move` est un nouvel outil d'écriture, toujours donné. Sans règle, il
-- s'exécute sans rien demander : un agent dont le propriétaire a BLOQUÉ
-- `file_write` (un relecteur en lecture seule) aurait pu, du jour au
-- lendemain, déplacer des fichiers. Un élargissement silencieux.
--
-- La forme générale : chaque règle sur `file_write` — quelle que soit son
-- action (block, require_approval, auto_approve), sa portée (un agent, ou
-- tous les agents de l'espace quand `agent_id` est nul) et sa condition
-- (un dossier) — donne la même règle sur `file_move`. Le propriétaire a
-- décidé de ce que cet agent peut écrire ; déplacer un fichier est écrire.
--
-- Idempotente, et elle n'écrase rien : une règle `file_move` déjà posée pour
-- le même (espace, agent) est gardée telle quelle (la contrainte d'unicité
-- traite deux `agent_id` nuls comme égaux).
INSERT INTO approval_rules (entity_id, agent_id, tool_name, action, condition_json)
SELECT entity_id, agent_id, 'file_move', action, condition_json
FROM approval_rules
WHERE tool_name = 'file_write'
ON CONFLICT ON CONSTRAINT approval_rules_entity_agent_tool_unique DO NOTHING;
