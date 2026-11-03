-- LE MODÈLE QUI ÉCOUTE REJOINT LA VOIX DE L'ESPACE (#976).
--
-- La ligne `entity_settings` de clé `voice` (0158) gagne `transcriptionModel` :
-- le modèle de l'endpoint de transcription d'OpenRouter
-- (`/audio/transcriptions`) qui transcrit les tours dits. Le chemin d'avant
-- (un modèle de CHAT, `google/gemini-2.5-flash`, à qui une consigne demandait
-- d'écrire ce qu'il entendait) est retiré : ce n'est pas un modèle de
-- l'endpoint (400 « does not exist », mesuré le 03/11), donc pas un choix du
-- même mécanisme.
--
-- La première valeur est `x-ai/grok-stt-1.0` (0,89 s en médiane, exact en
-- anglais et en français, mesuré le 03/11), pour tout espace. Le mode vocal
-- n'a été publié dans aucune version : aucune installation n'a de
-- comportement à garder (décision de l'orchestrateur, 03/11).
--
-- Deux gestes, une seule valeur (`first_voice_setting()`, redéfinie) :
--   1. les lignes existantes gagnent le champ, sans toucher au reste ;
--   2. un espace créé ensuite naît avec la valeur complète (le déclencheur de
--      0158 lit `first_voice_setting()`).
-- Une ligne qui ne se lit pas comme du JSON est laissée telle quelle : la
-- lecture la dit illisible (`voice_setting_unreadable`), jamais réparée en
-- silence.
--
-- Rejouable : une ligne qui porte déjà le champ n'est pas réécrite.
CREATE OR REPLACE FUNCTION first_voice_setting() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"source":"openrouter","model":"google/gemini-3.8-flash-tts","voice":"Kore","transcriptionModel":"x-ai/grok-stt-1.0"}'::text
$$;
--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT entity_id, value FROM entity_settings WHERE key = 'voice' LOOP
    BEGIN
      IF jsonb_typeof(r.value::jsonb) = 'object' AND NOT (r.value::jsonb ? 'transcriptionModel') THEN
        UPDATE entity_settings
          SET value = (r.value::jsonb || '{"transcriptionModel":"x-ai/grok-stt-1.0"}'::jsonb)::text,
              updated_at = now()
          WHERE entity_id = r.entity_id AND key = 'voice';
      END IF;
    EXCEPTION WHEN others THEN
      -- Pas du JSON : la ligne reste telle quelle, et se dira illisible.
      NULL;
    END;
  END LOOP;
END;
$$;
