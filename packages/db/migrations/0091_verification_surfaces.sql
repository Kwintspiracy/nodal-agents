-- 0091 — les surfaces sous vérification (D8, plan « Vérifier & Corriger », T15).
--
-- L'utilisateur décide, par espace, quelles façons de travailler posent une
-- intention de mutation et sont prouvées : une case par surface (l'outil de
-- code, les agents Claude Code / Codex, les outils fichiers, les commandes).
--
-- Deux colonnes, aucun backfill :
--
--   entities.verification_surfaces — le réglage. `'{}'` est VOULU : le défaut
--   « toutes activées » vit dans parseVerificationSurfaces() de
--   @nodal-agents/shared, il n'est pas deviné ici. C'est la leçon de 0084 : un
--   réglage est un geste délibéré, pas un état inventé par une migration.
--
--   agent_jobs.verification_skipped_surfaces — la trace FIGÉE, sur le run, des
--   surfaces décochées au moment où il a tourné. Une surface décochée n'écrit
--   aucune ligne d'état ; si l'owner la recoche demain, relire entities
--   raconterait les runs d'hier avec le réglage d'aujourd'hui. Le détail d'un
--   run dit « surface hors vérification » depuis CETTE colonne, jamais depuis
--   le réglage courant (D8 : dit tel quel, jamais silencieux).
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS verification_surfaces jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS verification_skipped_surfaces jsonb NOT NULL DEFAULT '[]'::jsonb;
