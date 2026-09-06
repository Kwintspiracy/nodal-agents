-- 0095 — le niveau de risque DÉCLARÉ par l'outil, sur la ligne d'audit (plan
-- « De la maquette au produit », P7).
--
-- P7 doit dire, pour chaque tour d'une conversation, si quelque chose est SORTI
-- du chat — un fichier, un envoi, une commande, une écriture dans une base
-- externe. Les trois premiers se lisent sur la carte persistée par P1 (`files`,
-- `sent`, `terminal`). Le quatrième, non : un connecteur tiers ne déclare que
-- la carte `generic`, la même pour une lecture Notion et pour une écriture
-- Notion. Son `riskLevel` (`read` | `write` | `destructive`) est le SEUL
-- classement dont on dispose, et il n'était écrit nulle part.
--
-- NULL sur les lignes d'avant (aucun backfill : rejouer le registre
-- d'aujourd'hui sur des lignes anciennes leur prêterait un risque que l'outil
-- de l'époque n'avait pas déclaré) et sur les lignes `cli:*`, que
-- l'enregistreur vivant du harnais écrit sans passer par le registre. L'écran
-- dit alors « incertain », il ne devine pas.
ALTER TABLE tool_calls
  ADD COLUMN IF NOT EXISTS risk_level text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_calls_risk_level_check') THEN
    ALTER TABLE tool_calls
      ADD CONSTRAINT tool_calls_risk_level_check
      CHECK (risk_level IS NULL OR risk_level IN ('read','write','destructive'));
  END IF;
END;
$$;
