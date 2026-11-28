-- 0175 — ce qu'un outil rend est masqué une fois, avant le modèle et avant les stockages.
--
-- `agents.mask_secret_shapes` : le réglage par agent de la seconde couche du
-- masque (les formes du masqueur unique). TRUE par défaut, pour chaque agent,
-- existant ou nouveau. Il ne commande jamais la première couche : les valeurs
-- exactes que Nodal garde pour l'espace restent masquées quoi qu'il dise.
--
-- `tool_calls.result_masked` : le masque a caché quelque chose dans le résultat
-- de CET appel. Ce que la ligne range est ce que le modèle a lu ; ce booléen dit
-- que ce n'était pas tout le contenu lu (un fichier lu masqué n'est pas une vue
-- de ses octets). FALSE pour les lignes d'avant 0175.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS mask_secret_shapes boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS result_masked boolean NOT NULL DEFAULT false;
