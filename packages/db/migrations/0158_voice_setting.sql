-- LA VOIX DE NODAL EST UN RÉGLAGE DE L'ESPACE (#969).
--
-- Une ligne `entity_settings` de clé `voice` par espace : la source (le
-- fournisseur qui parle), le modèle et la voix, en JSON
-- (`VoiceSettingSchema`, @nodal-agents/shared). Le tour vocal de tout client et
-- le défaut de `generate_speech` la relisent par une seule résolution
-- (apps/runner/src/job/resolve-voice.ts).
--
-- Règle du propriétaire (01/11/2026) : ce que l'écran montre est ce que le
-- moteur applique. La ligne existe donc POUR TOUT ESPACE, et aucun défaut ne se
-- calcule dans le code entre l'écran et le moteur : une ligne absente est une
-- erreur dite (`voice_setting_missing`), jamais remplacée.
--
-- La première valeur est exactement la voix d'avant ce réglage : OpenRouter,
-- `google/gemini-3.8-flash-tts`, `Kore`. Rien ne change pour personne tant
-- qu'il ne choisit pas.
--
-- Deux gestes, une seule valeur (`first_voice_setting()`) :
--   1. les espaces existants reçoivent leur ligne ;
--   2. un espace créé ensuite la reçoit à sa naissance, par un déclencheur :
--      quel que soit le chemin qui le crée (installation, inscription, espace
--      ajouté, banc), aucun n'a à s'en souvenir.
--
-- Rejouable : chaque instruction tient sur une base qui l'a déjà reçue, et une
-- ligne déjà choisie n'est jamais réécrite.
CREATE OR REPLACE FUNCTION first_voice_setting() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"source":"openrouter","model":"google/gemini-3.8-flash-tts","voice":"Kore"}'::text
$$;
--> statement-breakpoint
INSERT INTO entity_settings (entity_id, key, value)
SELECT id, 'voice', first_voice_setting() FROM entities
ON CONFLICT (entity_id, key) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION entities_seed_voice_setting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO entity_settings (entity_id, key, value)
  VALUES (NEW.id, 'voice', first_voice_setting())
  ON CONFLICT (entity_id, key) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS entities_seed_voice_setting ON entities;
--> statement-breakpoint
CREATE TRIGGER entities_seed_voice_setting
  AFTER INSERT ON entities
  FOR EACH ROW
  EXECUTE FUNCTION entities_seed_voice_setting();
