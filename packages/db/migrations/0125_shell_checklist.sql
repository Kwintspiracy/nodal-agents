-- CE QU'UN AGENT N'A PAS LE DROIT DE FAIRE AVEC UN SHELL, PAR SORTE D'ACTION (#464).
--
-- Run 06a949cb → b4b493e8 (23/09) : sous `destructive_gate`, un agent a écrit
-- un script Python puis l'a lancé par `run_command` sur des fichiers de
-- Downloads et Documents, des dossiers qu'on ne lui avait jamais donnés.
-- Personne n'a été consulté : la commande était « ordinaire ».
--
-- `agents.shell_policy` porte, par agent, l'état de chaque sorte d'action :
-- `allow`, `ask` ou `never` (liste dans packages/shared/src/shell-checklist.ts).
-- NULL, ou une sorte absente, veut dire `ask`.
--
-- `approval_requests.gate_reasons` porte POURQUOI la liste a retenu une
-- commande (les chemins hors des dossiers, le script écrit par l'agent) : la
-- carte d'approbation les montre.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "shell_policy" jsonb;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "gate_reasons" jsonb;
--> statement-breakpoint
-- Un agent à qui le propriétaire a déjà donné le shell sans demander, PARTOUT
-- (le toggle Yolo : une règle `run_command → auto_approve` sans condition)
-- garde ce qu'il avait : chaque sorte d'action y est permise… sauf sortir de
-- ses dossiers, la frontière que ce ticket pose. Une règle confinée à un
-- dossier (`condition_json.workspacePath`, #360) ne vaut que là : l'étendre à
-- toute la liste rendrait `rm` permis hors de ce dossier (revue Codex de #464,
-- P1). Ces agents-là, comme tous les autres, demandent pour tout (NULL).
UPDATE "agents"
SET "shell_policy" = '{"outside_folders":"ask","own_script":"allow","delete_files":"allow","install_software":"allow","download":"allow","stop_programs":"allow","system_settings":"allow"}'::jsonb
WHERE "shell_policy" IS NULL
  AND "id" IN (
    SELECT "agent_id" FROM "approval_rules"
    WHERE "tool_name" = 'run_command' AND "action" = 'auto_approve' AND "agent_id" IS NOT NULL
      AND ("condition_json" IS NULL OR "condition_json" = '{}'::jsonb)
  );
