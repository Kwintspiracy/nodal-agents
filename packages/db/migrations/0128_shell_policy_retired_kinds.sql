-- LES DEUX SORTES D'ACTION RETIRÉES DE LA LISTE DU SHELL (#464, PR #476).
--
-- La première version de la liste (PR #474, fermée) portait deux sortes que la
-- version réduite n'a plus : `outside_folders` (lire des chemins dans la
-- commande et les scripts) et `own_script` (un script écrit par l'agent). Une
-- lecture du texte ne pouvait pas tenir ces promesses ; garder un agent dans
-- ses dossiers demande un bac à sable de l'OS (#475).
--
-- Seule une base qui a fait tourner la première 0125 porte ces clés. Le schéma
-- strict (`resolveShellPolicy`) les refuse, et un job s'arrêterait alors sur
-- `shell_policy_invalid`. Ici : `own_script` couvrait aussi le code en ligne
-- (`python -c`), son état passe donc à `inline_code` quand celui-ci n'est pas
-- déjà réglé ; `outside_folders` disparaît, il ne correspond plus à rien.
-- Ailleurs, ces deux ordres ne touchent aucune ligne.
UPDATE "agents"
SET "shell_policy" = ("shell_policy" - 'outside_folders' - 'own_script')
  || CASE
       WHEN "shell_policy" ? 'own_script' AND NOT "shell_policy" ? 'inline_code'
       THEN jsonb_build_object('inline_code', "shell_policy" -> 'own_script')
       ELSE '{}'::jsonb
     END
WHERE "shell_policy" ?| ARRAY['outside_folders', 'own_script'];
--> statement-breakpoint
UPDATE "agents" SET "shell_policy" = NULL WHERE "shell_policy" = '{}'::jsonb;
--> statement-breakpoint
-- Les raisons déjà posées sur une demande : la carte ne sait plus les nommer.
UPDATE "approval_requests"
SET "gate_reasons" = (
  SELECT jsonb_agg(e)
  FROM jsonb_array_elements("gate_reasons") AS e
  WHERE e ->> 'category' NOT IN ('outside_folders', 'own_script')
)
WHERE jsonb_typeof("gate_reasons") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements("gate_reasons") AS e
    WHERE e ->> 'category' IN ('outside_folders', 'own_script')
  );
