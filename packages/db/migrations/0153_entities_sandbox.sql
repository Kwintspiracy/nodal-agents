-- LE BAC À SABLE SE RÈGLE PAR ESPACE (#876).
--
-- 1. `entities.sandbox_enabled` : l'interrupteur de l'espace. ALLUMÉ par
--    défaut, la valeur que le runner applique aujourd'hui (toute commande est
--    confinée quand le bac à sable est disponible) : la migration ne change le
--    comportement de personne. Coupé, les commandes de l'espace tournent sans
--    confinement et chaque résultat le dit (`SANDBOX_DISABLED`). Le runner le
--    relit à chaque commande, jamais figé par la sonde.
--
-- 2. `entities.sandbox_folders` : les GESTES de l'utilisateur sur la liste des
--    dossiers permis — `added` (ses dossiers) et `removed` (les dossiers
--    détectés qu'il a retirés). Jamais la liste calculée : un magasin installé
--    plus tard apparaît tout seul, la détection étant refaite à chaque
--    ouverture de conteneur. Lu par `parseSandboxFolders` (@nodal-agents/shared),
--    qui refuse une forme inconnue au lieu de la lire comme une liste vide.
ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "sandbox_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "sandbox_folders" jsonb NOT NULL DEFAULT '{"added":[],"removed":[]}'::jsonb;
