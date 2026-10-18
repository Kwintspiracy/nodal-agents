-- Le régime d'une commande de preuve (#628) : `confined` quand le bac à
-- sable de Nodal l'a confinée, sinon le code stable de la raison
-- (`SANDBOX_NOT_IMPLEMENTED`, `SANDBOX_PLATFORM_UNSUPPORTED`…). Une preuve qui a
-- tourné sans confinement le dit ainsi, avec elle, et pas seulement dans un
-- journal. NULL sur les lignes écrites avant cette colonne.
ALTER TABLE verification_runs ADD COLUMN IF NOT EXISTS sandbox text;
