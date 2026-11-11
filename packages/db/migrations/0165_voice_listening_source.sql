-- LA PART QUI ÉCOUTE A SA SOURCE (#1048).
--
-- Parler et écouter ont chacun leur source. La part qui parle avait déjà la
-- sienne (`source`) ; celle qui écoute gagne `transcriptionSource` :
-- `openrouter` (l'endpoint de transcription d'OpenRouter, la clé de l'espace)
-- ou `openai-compatible` (un serveur que la personne fait tourner, à
-- l'adresse de `transcriptionServer`).
--
-- Ce que la migration écrit n'est pas un défaut : c'est le fait. Avant elle,
-- toute oreille était celle d'OpenRouter (`resolveEar` ne connaissait que
-- lui, #976). Chaque ligne existante le dit donc désormais, sans que rien
-- d'autre ne bouge, et un espace créé ensuite naît avec la valeur complète
-- (le déclencheur de 0158 lit `first_voice_setting()`, redéfinie ici).
--
-- Une ligne qui ne se lit pas comme un objet JSON est laissée telle quelle :
-- la lecture la dit illisible (`voice_setting_unreadable`), jamais réparée en
-- silence. Rejouable : une ligne qui porte déjà le champ n'est pas réécrite.
CREATE OR REPLACE FUNCTION first_voice_setting() RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"source":"openrouter","model":"google/gemini-3.8-flash-tts","voice":"Kore","transcriptionSource":"openrouter","transcriptionModel":"x-ai/grok-stt-1.0"}'::text
$$;
--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT entity_id, value FROM entity_settings WHERE key = 'voice' LOOP
    BEGIN
      IF jsonb_typeof(r.value::jsonb) = 'object' AND NOT (r.value::jsonb ? 'transcriptionSource') THEN
        UPDATE entity_settings
          SET value = (r.value::jsonb || '{"transcriptionSource":"openrouter"}'::jsonb)::text,
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
