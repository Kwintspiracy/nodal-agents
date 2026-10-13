-- Le prompt stocké d'un job porte la version de Nodal qui l'a écrit (lot 2 de
-- la 0.9.5, revue de #655).
--
-- `executeJob` réutilise `system_prompt` à chaque reprise (approbation,
-- délégation, redémarrage) pour garder le cache de préfixe, et ne le réécrivait
-- que si la liste d'outils avait changé (0136). Un job en attente pendant une
-- mise à jour reprenait donc avec le prompt de l'ANCIENNE version et les outils
-- de la nouvelle : ce qu'un changement du constructeur de prompt déplace d'un
-- outil vers le prompt (ou l'inverse) n'était plus dit nulle part.
--
-- La version est celle que le lanceur lit dans le paquet installé
-- (NODAL_VERSION), celle que le bloc `## Runtime` du même prompt énonce : tout
-- changement du code arrive chez un utilisateur par une nouvelle version.
--
-- NULL : prompt écrit avant cette colonne, ou par un runner qui ne connaît pas
-- sa version. Une reprise sous une version connue le réécrit.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS system_prompt_version text;
