// voice-setting.ts — la voix avec laquelle Nodal parle, un réglage de l'espace (#969).
//
// Trois faits, posés depuis Réglages → Voice ou par la route du runner
// (`/api/voice/setting`, que tout module peut appeler, règle du #948) :
//
//   - `source` : qui synthétise. `openrouter` (la clé OpenRouter de l'espace)
//     ou `google` (la clé Google de l'espace, Gemini en
//     direct, en flux) ;
//   - `model` : le modèle de cette source, tel qu'elle le nomme ;
//   - `voice` : une voix que CE modèle offre.
//
// Le réglage vit dans `entity_settings` (clé `voice`), une ligne par espace,
// posée par la migration 0158 et à la naissance de chaque espace. Aucun défaut
// ne se calcule entre l'écran et le moteur : une ligne absente ou illisible
// est une erreur dite, avec son code (invariant #4).
//
// Le module est bundlé côté client (l'écran des réglages) : aucun import `node:`.

import { z } from 'zod';

/** La clé de la ligne `entity_settings`. */
export const VOICE_SETTING_KEY = 'voice';

/** Les sources qui peuvent porter la voix d'un espace. */
export const VOICE_SOURCES = ['openrouter', 'google'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];

export const VoiceSettingSchema = z
  .object({
    source: z.enum(VOICE_SOURCES),
    model: z.string().trim().min(1),
    voice: z.string().trim().min(1),
  })
  .strict();
export type VoiceSetting = z.infer<typeof VoiceSettingSchema>;

/**
 * Les codes de ce qui empêche la voix de parler. Des faits, jamais des
 * phrases : l'écran ou le module les dit (invariant #2).
 */
export const VOICE_FAILURE_CODES = [
  /** L'espace n'a pas de ligne `voice`. */
  'voice_setting_missing',
  /** La ligne existe et ne se lit pas comme un réglage. */
  'voice_setting_unreadable',
  /** La source choisie n'a pas de clé active dans l'espace. */
  'voice_key_missing',
  /** La clé existe et ne se déchiffre pas. */
  'voice_key_undecryptable',
  /** La source n'a pas pu dire ses modèles (réseau, refus). */
  'voice_catalog_unreachable',
  /** Le modèle n'est pas parmi ceux que la source offre. */
  'voice_model_not_offered',
  /** La voix n'est pas parmi celles que le modèle offre. */
  'voice_not_offered',
] as const;
export type VoiceFailureCode = (typeof VOICE_FAILURE_CODES)[number];

/**
 * Le réglage tel que la base le rend. LÈVE avec `voice_setting_unreadable` :
 * une forme inconnue n'est jamais remplacée par une voix plausible.
 */
export function parseVoiceSetting(raw: string): VoiceSetting {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`voice_setting_unreadable: not JSON (${raw.slice(0, 80)})`);
  }
  const parsed = VoiceSettingSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `voice_setting_unreadable: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

// ─── Ce que le runner dit des choix (GET /api/voice/setting) ─────────────────
//
// Les modèles et les voix viennent des fournisseurs, jamais d'une liste du
// code (#969) : OpenRouter les dit par son API des modèles (`supported_voices`),
// Google ses modèles TTS par la sienne. Le web valide la réponse par ce schéma
// et en fait l'écran ; il ne recalcule rien.

export const VoiceChoiceVoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const VoiceChoiceModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Vide : la source ne liste aucune voix pour ce modèle, qui ne se choisit pas. */
  voices: z.array(VoiceChoiceVoiceSchema),
});
export type VoiceChoiceModel = z.infer<typeof VoiceChoiceModelSchema>;

export const VoiceSourceChoicesSchema = z.discriminatedUnion('state', [
  z.object({
    source: z.enum(VOICE_SOURCES),
    state: z.literal('available'),
    models: z.array(VoiceChoiceModelSchema),
    /** Quand la source a dit sa liste (ISO), et combien de temps le runner la garde. */
    listedAt: z.string(),
    cacheSeconds: z.number().int().positive(),
  }),
  z.object({
    source: z.enum(VOICE_SOURCES),
    state: z.literal('unavailable'),
    code: z.enum(VOICE_FAILURE_CODES),
    /** Les mots du fournisseur ou de la base, quand il y en a. */
    detail: z.string().optional(),
  }),
]);
export type VoiceSourceChoices = z.infer<typeof VoiceSourceChoicesSchema>;

/**
 * La voix de l'espace et ce que chaque source offre. `setting: null` : la
 * ligne manque ou ne se lit pas, et `settingProblem` dit pourquoi — l'écran le
 * dit et laisse choisir une voix, il n'en montre jamais une supposée.
 */
export const VoiceStateSchema = z.object({
  setting: VoiceSettingSchema.nullable(),
  settingProblem: z
    .object({ code: z.enum(VOICE_FAILURE_CODES), detail: z.string().optional() })
    .optional(),
  sources: z.array(VoiceSourceChoicesSchema),
});
export type VoiceState = z.infer<typeof VoiceStateSchema>;

/** Ce qu'un module (ou l'écran) envoie pour choisir la voix de l'espace. */
export const VoiceSettingWriteSchema = z.object({
  entityId: z.string().guid(),
  setting: VoiceSettingSchema,
});

/**
 * L'essai d'une voix : une phrase courte, dite par le même chemin que le tour.
 * La phrase vient de l'appelant (l'écran a sa copie ; le runner n'écrit aucune
 * phrase, invariant #2). `setting` absent : la voix enregistrée ; présent : la
 * voix que l'écran montre, avant de l'enregistrer.
 */
export const VOICE_SAMPLE_MAX_CHARS = 300;
export const VoiceSampleRequestSchema = z.object({
  entityId: z.string().guid(),
  text: z.string().trim().min(1).max(VOICE_SAMPLE_MAX_CHARS),
  setting: VoiceSettingSchema.optional(),
});
