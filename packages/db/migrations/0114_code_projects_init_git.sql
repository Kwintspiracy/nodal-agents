-- NODAL PEUT POSER GIT DANS UN PROJET — UNE OPTION, JAMAIS UN GESTE D'OFFICE
-- (issue #200).
--
-- Le constat par git (#199) s'active de lui-même dès que le dossier d'un
-- projet est un dépôt. Une personne qui démarre un projet depuis Telegram ou
-- depuis le chat de Nodal n'a pas git : le meilleur constat que le produit
-- sache faire ne lui serait jamais offert. Nodal doit donc savoir poser le
-- dépôt — et seulement quand on le lui demande.
--
-- `init_git` est ce que le propriétaire a demandé, OFF par défaut. Rien ne
-- touche à un dossier sans elle : ni à la création d'un projet, ni plus tard.
-- Un dossier qui est DÉJÀ un dépôt n'est jamais retouché — l'option dit « je
-- veux que ce dossier soit versionné », pas « recommence ».
--
-- `git_initialized_at` est le FAIT, distinct de l'intention : l'instant où
-- Nodal a effectivement lancé `git init` dans ce dossier. Les deux colonnes
-- sont nécessaires et ne se déduisent pas l'une de l'autre — l'option peut
-- être ON sur un dossier qui était déjà un dépôt (rien n'a été posé), et elle
-- peut être éteinte plus tard sans que le dépôt disparaisse. C'est cette
-- colonne que l'écran montre pour dire ce qui s'est passé, plutôt que de le
-- déduire d'un drapeau.
ALTER TABLE "code_projects" ADD COLUMN IF NOT EXISTS "init_git" boolean NOT NULL DEFAULT false;

ALTER TABLE "code_projects" ADD COLUMN IF NOT EXISTS "git_initialized_at" timestamptz;
