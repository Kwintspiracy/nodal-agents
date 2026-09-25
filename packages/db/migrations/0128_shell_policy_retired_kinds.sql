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
       -- `inline_code` absent OU à null JSON : dans les deux cas rien n'y est
       -- réglé, et un null resterait refusé par le schéma strict (revue de la
       -- PR #497).
       WHEN "shell_policy" ? 'own_script'
            AND jsonb_typeof("shell_policy" -> 'inline_code') IS DISTINCT FROM 'string'
       THEN jsonb_build_object('inline_code', "shell_policy" -> 'own_script')
       ELSE '{}'::jsonb
     END
WHERE "shell_policy" ?| ARRAY['outside_folders', 'own_script'];
--> statement-breakpoint
UPDATE "agents" SET "shell_policy" = NULL WHERE "shell_policy" = '{}'::jsonb;
--> statement-breakpoint
-- Les raisons déjà posées sur une demande : la carte ne sait plus les nommer.
-- Ne restent que les raisons LISIBLES : une catégorie, et pas une des deux
-- retirées. Un élément sans catégorie part aussi, et c'est voulu : la carte lit
-- le tableau d'un bloc (`ShellGateReasonsSchema`), et un seul élément illisible
-- lui faisait perdre toutes les raisons, les valides comprises (revue de la
-- PR #497, passes 1 et 2).
UPDATE "approval_requests"
SET "gate_reasons" = (
  SELECT jsonb_agg(e)
  FROM jsonb_array_elements("gate_reasons") AS e
  WHERE e ->> 'category' IS NOT NULL
    AND e ->> 'category' NOT IN ('outside_folders', 'own_script')
)
-- Le CASE ordonne les deux tests : Postgres ne garantit pas l'ordre d'un AND,
-- et `jsonb_array_elements` sur une valeur qui n'est pas un tableau lève une
-- erreur (revue de la PR #497).
WHERE CASE
        WHEN jsonb_typeof("gate_reasons") = 'array' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements("gate_reasons") AS e
          WHERE e ->> 'category' IN ('outside_folders', 'own_script')
        )
        ELSE false
      END;
