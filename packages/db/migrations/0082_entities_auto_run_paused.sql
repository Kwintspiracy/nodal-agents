-- 0082 — inversion du modele a deux cles Yolo (decision Quentin 24/08).
--
-- L'ancien lan_command_yolo etait une PRE-CONDITION : sur une install reseau,
-- il fallait l'allumer pour avoir LE DROIT d'activer le Yolo par agent — deux
-- serrures, une seule cle (les deux gestes etaient deja owner-only). Sa vraie
-- valeur etait le coupe-circuit : l'eteindre rendait dormantes toutes les
-- regles d'un coup. auto_run_paused ne garde QUE ce role : un frein
-- d'urgence, inactif par defaut, qui met en pause tout l'auto-run de code du
-- workspace quand on l'enclenche.
--
-- Le backfill preserve l'INTENTION de chaque install : un master OFF alors
-- que des regles auto_approve d'outils d'execution existent = le proprietaire
-- avait deliberement coupe (usage coupe-circuit) -> pause maintenue. Un
-- master OFF sans aucune regle armee (l'immense majorite, dont toute install
-- neuve) = rien a couper -> pas de pause. Un master ON = il autorisait ->
-- pas de pause. Aucun comportement effectif ne change au reboot.
ALTER TABLE entities ADD COLUMN auto_run_paused boolean NOT NULL DEFAULT false;

UPDATE entities e
SET auto_run_paused = true
WHERE e.lan_command_yolo = false
  AND EXISTS (
    SELECT 1
    FROM approval_rules ar
    LEFT JOIN agents a ON a.id = ar.agent_id
    WHERE ar.action = 'auto_approve'
      AND ar.tool_name IN ('run_command', 'code_task', 'run_skill_script',
                           'skill_file_write', 'create_mcp', 'attach_mcp')
      AND (a.entity_id = e.id OR ar.entity_id = e.id)
  );

ALTER TABLE entities DROP COLUMN lan_command_yolo;
