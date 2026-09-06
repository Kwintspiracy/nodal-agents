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
-- DROP puis ADD, jamais ALTER : une contrainte CHECK ne se modifie pas en
-- place. `IF EXISTS` rend la migration rejouable sur une base où la contrainte
-- aurait déjà été retirée à la main.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_origin_check;
--> statement-breakpoint
ALTER TABLE conversations
  ADD CONSTRAINT conversations_origin_check
  CHECK (origin IN ('user', 'onboarding', 'project'));
