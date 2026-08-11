-- Voix par agent (phase 1 du pipeline voix, 2026-08-11).
--
-- NULL = muet : l'agent n'est jamais synthétisé, ce qui est le comportement
-- d'avant la fonctionnalité, à l'octet près. Choisir une voix est un geste
-- explicite — un défaut ferait parler tous les agents existants du jour au
-- lendemain, et facturerait la synthèse de chacun de leurs messages.
--
-- Deux colonnes plutôt qu'une chaîne « google:Kore » : le fournisseur et
-- l'identifiant de voix se lisent, s'indexent et se valident séparément. Les
-- deux restent du texte libre, comme reasoning_effort : le catalogue de voix
-- vit dans packages/speech et change au rythme des fournisseurs, pas au rythme
-- des migrations.
--
-- Cohérence garantie par un CHECK : soit les deux sont renseignées, soit
-- aucune. Un fournisseur sans voix, ou une voix sans fournisseur, ne veut rien
-- dire et se réglerait par un repli silencieux au moment de parler — ce que
-- l'invariant #4 interdit.
ALTER TABLE "agents" ADD COLUMN "voice_provider" text;
ALTER TABLE "agents" ADD COLUMN "voice_id" text;

ALTER TABLE "agents" ADD CONSTRAINT "agents_voice_pair_check"
  CHECK (
    ("voice_provider" IS NULL AND "voice_id" IS NULL)
    OR ("voice_provider" IS NOT NULL AND "voice_id" IS NOT NULL)
  );
