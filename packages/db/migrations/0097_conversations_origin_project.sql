-- 0097 — une conversation peut naître D'UN PROJET (revue Codex de P8, passe
-- 30, doute 1).
--
-- P8 désignait « la conversation du projet » comme la plus récente conversation
-- ancrée au projet. C'était instable : une conversation simplement ancrée
-- parce qu'une production y a atterri évince celle qu'on a explicitement
-- ouverte depuis la page du projet, dès que son `updated_at` passe devant. La
-- saisie du bas changeait alors de fil sans que personne ne l'ait demandé.
--
-- L'ORIGINE tranche, et elle est stampée à la création, jamais réécrite —
-- comme `onboarding` depuis 0065. `project` veut dire « ouverte depuis la page
-- d'un projet » ; c'est ce fil-là que la saisie prolonge. Une conversation
-- seulement ancrée reste listée sur la page, et reste une conversation de
-- l'utilisateur : seul l'accueil est tenu hors des listes.
--
-- AUCUNE ligne existante n'est requalifiée, et c'est voulu (revue Codex, passe
-- 31) : la seule écriture qui ancre une conversation à sa création
-- (`createProjectConversationAction`) est née dans le MÊME lot que cette
-- migration, jamais publiée sans elle — aucune install n'a de conversation de
-- projet en `origin = 'user'`. Une conversation seulement ANCRÉE par une
-- production (P6, `current_project_id` posé après coup) n'a jamais été « la
-- conversation du projet » : la requalifier lui ferait dire ce qu'elle n'est
-- pas. Mesuré sur la base dev le 06/09 : zéro ligne ancrée avant cette
-- migration.
--
-- DROP puis ADD, jamais ALTER : une contrainte CHECK ne se modifie pas en
-- place. `IF EXISTS` rend la migration rejouable sur une base où la contrainte
-- aurait déjà été retirée à la main.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_origin_check;
--> statement-breakpoint
ALTER TABLE conversations
  ADD CONSTRAINT conversations_origin_check
  CHECK (origin IN ('user', 'onboarding', 'project'));
