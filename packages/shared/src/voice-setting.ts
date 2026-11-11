// voice-setting.ts — la voix avec laquelle Nodal parle, un réglage de l'espace (#969).
//
// Des faits, posés depuis Réglages → Voice ou par la route du runner
// (`/api/voice/setting`, que tout module peut appeler, règle du #948) :
//
//   - `source` : qui synthétise. `openrouter` (la clé OpenRouter de l'espace),
//     `google` (la clé Google de l'espace, Gemini en direct, en flux) ou
//     `openai-compatible` (un serveur de la personne, à `speechServer`, #1048) ;
//   - `model` : le modèle de cette source, tel qu'elle le nomme ;
//   - `voice` : une voix que CE modèle offre ;
//   - `transcriptionSource` (#1048) : qui ÉCOUTE, `openrouter` ou
//     `openai-compatible` (à `transcriptionServer`) ;
//   - `transcriptionModel` (#976) : le modèle qui écoute, tel que sa source le
//     nomme.
//
// Le réglage vit dans `entity_settings` (clé `voice`), une ligne par espace,
// posée par la migration 0158 et à la naissance de chaque espace (0160 y a mis
// le modèle qui écoute, 0165 la source qui écoute). Aucun défaut
// ne se calcule entre l'écran et le moteur : une ligne absente ou illisible
// est une erreur dite, avec son code (invariant #4).
//
// Le module est bundlé côté client (l'écran des réglages) : aucun import `node:`.

import { z } from 'zod';

/** La clé de la ligne `entity_settings`. */
export const VOICE_SETTING_KEY = 'voice';

// ─── Deux parts, chacune avec sa source (#1048) ──────────────────────────────
//
// Parler et écouter ont chacun leur source. Deux sortes de sources :
//   - celles qu'on joint avec une clé de l'espace (LLM Providers) :
//     `openrouter`, `google` ;
//   - `openai-compatible` : un serveur que la personne fait tourner elle-même
//     (un serveur Whisper, whisper.cpp, Speaches, LocalAI…), joint à l'ADRESSE
//     qu'elle donne, par la surface audio standard d'OpenAI. Nodal n'en livre
//     aucun, et ne le démarre ni ne l'arrête jamais. L'écran l'appelle
//     « Local server ».
//
// L'adresse et la clé facultative d'un serveur vivent DANS le réglage, à côté
// de la part qu'elles servent (`speechServer`, `transcriptionServer`) : deux
// serveurs différents peuvent parler et écouter. La clé y est rangée chiffrée
// par packages/secrets (`enc:v1:…`), jamais en clair, et ne repart jamais vers
// un client : la lecture rend `hasKey`, l'écriture dit `keep`, `none` ou la
// nouvelle valeur. Pourquoi pas `entity_llm_keys` : ses lignes sont des clés
// de MODÈLES DE LANGUE, lues comme telles ailleurs (la liste des fournisseurs,
// `list_models`, qui prend la première clé active pour « le » fournisseur de
// l'espace) ; un serveur de voix y deviendrait un fournisseur de chat.

/** Les sources qui peuvent porter la voix (la part qui PARLE). */
export const VOICE_SOURCES = ['openrouter', 'google', 'openai-compatible'] as const;
export type VoiceSource = (typeof VOICE_SOURCES)[number];
/** Les sources de la part qui ÉCOUTE. */
export const TRANSCRIPTION_SOURCES = ['openrouter', 'openai-compatible'] as const;
export type TranscriptionSource = (typeof TRANSCRIPTION_SOURCES)[number];
/** Les sources jointes avec une clé de l'espace ; les autres le sont à l'adresse du réglage. */
export const KEYED_VOICE_SOURCES = ['openrouter', 'google'] as const;
export type KeyedVoiceSource = (typeof KEYED_VOICE_SOURCES)[number];
/** La source jointe à l'adresse que la personne donne. */
export const SERVER_VOICE_SOURCE = 'openai-compatible';
/** Les deux parts du réglage. */
export const VOICE_PARTS = ['speaking', 'listening'] as const;
export type VoicePart = (typeof VOICE_PARTS)[number];

/**
 * L'adresse d'un serveur, telle que la personne la tape (`http://127.0.0.1:8786/v1`).
 * http ou https seulement ; les `/` de fin sont retirés : `…/v1/` et `…/v1`
 * sont le même serveur, et une seule forme entre en base.
 */
export const VoiceServerAddressSchema = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https?$/ }))
  .transform((s) => s.replace(/\/+$/, ''));

/** Une clé au repos : le blob de packages/secrets, jamais la clé elle-même. */
const KeyAtRestSchema = z.string().regex(/^enc:v1:/, 'a key at rest is an enc:v1: blob');

/** Le serveur d'une part, tel que la base le porte. */
export const VoiceServerSchema = z
  .object({ address: VoiceServerAddressSchema, key: KeyAtRestSchema.optional() })
  .strict();
export type VoiceServer = z.infer<typeof VoiceServerSchema>;

/** Le serveur d'une part, tel qu'un client le lit : la clé n'en sort jamais. */
export const VoiceServerViewSchema = z
  .object({ address: VoiceServerAddressSchema, hasKey: z.boolean() })
  .strict();
export type VoiceServerView = z.infer<typeof VoiceServerViewSchema>;

/**
 * Ce qu'un client dit de la clé quand il écrit : `keep` (celle qui est rangée
 * pour CETTE part à CETTE adresse), `none` (aucune), ou une nouvelle valeur.
 * Rien n'est supposé : la forme est obligatoire.
 */
export const VoiceServerKeyInputSchema = z.union([
  z.literal('keep'),
  z.literal('none'),
  z.object({ value: z.string().trim().min(1) }).strict(),
]);
export type VoiceServerKeyInput = z.infer<typeof VoiceServerKeyInputSchema>;

/** Le serveur d'une part, tel qu'un client l'écrit. */
export const VoiceServerInputSchema = z
  .object({ address: VoiceServerAddressSchema, key: VoiceServerKeyInputSchema })
  .strict();
export type VoiceServerInput = z.infer<typeof VoiceServerInputSchema>;

const speakingFields = <S extends z.ZodType>(server: S) => ({
  source: z.enum(VOICE_SOURCES),
  model: z.string().trim().min(1),
  voice: z.string().trim().min(1),
  speechServer: server.optional(),
});
const listeningFields = <S extends z.ZodType>(server: S) => ({
  transcriptionSource: z.enum(TRANSCRIPTION_SOURCES),
  transcriptionModel: z.string().trim().min(1),
  transcriptionServer: server.optional(),
});

/** Un serveur pour la source jointe à une adresse, et pour elle seule. */
function speakingRule(s: { source: string; speechServer?: unknown }, ctx: z.RefinementCtx): void {
  if ((s.source === SERVER_VOICE_SOURCE) !== (s.speechServer !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['speechServer'],
      message: `speechServer is required with source ${SERVER_VOICE_SOURCE}, and only with it`,
    });
  }
}
function listeningRule(
  s: { transcriptionSource: string; transcriptionServer?: unknown },
  ctx: z.RefinementCtx,
): void {
  if ((s.transcriptionSource === SERVER_VOICE_SOURCE) !== (s.transcriptionServer !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['transcriptionServer'],
      message: `transcriptionServer is required with transcriptionSource ${SERVER_VOICE_SOURCE}, and only with it`,
    });
  }
}
function settingSchema<S extends z.ZodType>(server: S) {
  return z
    .object({ ...speakingFields(server), ...listeningFields(server) })
    .strict()
    .superRefine((s, ctx) => {
      speakingRule(s, ctx);
      listeningRule(s, ctx);
    });
}

/** Le réglage tel que la base le porte (clés chiffrées). */
export const VoiceSettingSchema = settingSchema(VoiceServerSchema);
export type VoiceSetting = z.infer<typeof VoiceSettingSchema>;
/** Le réglage tel qu'un client le lit (`hasKey`, jamais la clé). */
export const VoiceSettingViewSchema = settingSchema(VoiceServerViewSchema);
export type VoiceSettingView = z.infer<typeof VoiceSettingViewSchema>;
/** Le réglage tel qu'un client l'écrit (`keep` / `none` / une valeur). */
export const VoiceSettingInputSchema = settingSchema(VoiceServerInputSchema);
export type VoiceSettingInput = z.infer<typeof VoiceSettingInputSchema>;

/** La part qui PARLE, rangée : la source, le modèle, la voix, et le serveur s'il y en a un. */
export type SpeakingVoice = Pick<VoiceSetting, 'source' | 'model' | 'voice' | 'speechServer'>;
/** La part qui ÉCOUTE, rangée. */
export type ListeningEar = Pick<
  VoiceSetting,
  'transcriptionSource' | 'transcriptionModel' | 'transcriptionServer'
>;

/** La part qui parle, telle qu'un client l'écrit (l'essai, le contrôle). */
export const SpeakingVoiceInputSchema = z
  .object(speakingFields(VoiceServerInputSchema))
  .strict()
  .superRefine(speakingRule);
export type SpeakingVoiceInput = z.infer<typeof SpeakingVoiceInputSchema>;
/** La part qui écoute, telle qu'un client l'écrit (le contrôle). */
export const ListeningEarInputSchema = z
  .object(listeningFields(VoiceServerInputSchema))
  .strict()
  .superRefine(listeningRule);
export type ListeningEarInput = z.infer<typeof ListeningEarInputSchema>;

/** Le réglage rangé, tel qu'un client le lit : chaque clé devient `hasKey`. */
export function voiceSettingView(s: VoiceSetting): VoiceSettingView {
  const view = (server: VoiceServer | undefined) =>
    server ? { address: server.address, hasKey: server.key !== undefined } : undefined;
  const speechServer = view(s.speechServer);
  const transcriptionServer = view(s.transcriptionServer);
  return {
    source: s.source,
    model: s.model,
    voice: s.voice,
    ...(speechServer ? { speechServer } : {}),
    transcriptionSource: s.transcriptionSource,
    transcriptionModel: s.transcriptionModel,
    ...(transcriptionServer ? { transcriptionServer } : {}),
  };
}

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
  /** Le modèle de transcription n'est pas parmi ceux qu'OpenRouter sert (#976). */
  'transcription_model_not_offered',
  /** Le modèle de transcription, essayé sur un échantillon connu, n'a pas rendu ses mots (#976). */
  'transcription_not_faithful',
  /**
   * `key: 'keep'` pour un serveur dont aucune clé n'est rangée à CETTE adresse
   * pour CETTE part (#1048) : une clé ne suit jamais une adresse changée, elle
   * partirait vers un autre serveur que celui pour lequel on l'a donnée.
   */
  'voice_server_key_not_kept',
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

// Les sources jointes avec une clé de l'espace. Un serveur (#1048) dit ses
// modèles à l'adresse que l'écran montre : `VoiceServerModelsSchema`, plus bas.
export const VoiceSourceChoicesSchema = z.discriminatedUnion('state', [
  z.object({
    source: z.enum(KEYED_VOICE_SOURCES),
    state: z.literal('available'),
    models: z.array(VoiceChoiceModelSchema),
    /** Quand la source a dit sa liste (ISO), et combien de temps le runner la garde. */
    listedAt: z.string(),
    cacheSeconds: z.number().int().positive(),
  }),
  z.object({
    source: z.enum(KEYED_VOICE_SOURCES),
    state: z.literal('unavailable'),
    code: z.enum(VOICE_FAILURE_CODES),
    /** Les mots du fournisseur ou de la base, quand il y en a. */
    detail: z.string().optional(),
  }),
]);
export type VoiceSourceChoices = z.infer<typeof VoiceSourceChoicesSchema>;

/** Ce que l'endpoint de transcription d'OpenRouter offre, ou pourquoi il ne l'offre pas (#976). */
export const TranscriptionChoicesSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    listedAt: z.string(),
    cacheSeconds: z.number().int().positive(),
  }),
  z.object({
    state: z.literal('unavailable'),
    code: z.enum(VOICE_FAILURE_CODES),
    detail: z.string().optional(),
  }),
]);
export type TranscriptionChoices = z.infer<typeof TranscriptionChoicesSchema>;

/**
 * La voix de l'espace et ce que chaque source offre. `setting: null` : la
 * ligne manque ou ne se lit pas, et `settingProblem` dit pourquoi — l'écran le
 * dit et laisse choisir une voix, il n'en montre jamais une supposée. Le
 * réglage est rendu tel qu'un client le lit : une clé n'en sort jamais.
 */
export const VoiceStateSchema = z.object({
  setting: VoiceSettingViewSchema.nullable(),
  settingProblem: z
    .object({ code: z.enum(VOICE_FAILURE_CODES), detail: z.string().optional() })
    .optional(),
  sources: z.array(VoiceSourceChoicesSchema),
  transcription: TranscriptionChoicesSchema,
});
export type VoiceState = z.infer<typeof VoiceStateSchema>;

/** Ce qu'un module (ou l'écran) envoie pour choisir la voix de l'espace. */
export const VoiceSettingWriteSchema = z.object({
  entityId: z.string().guid(),
  setting: VoiceSettingInputSchema,
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
  // La voix seule : l'essai parle, il n'écoute pas (#976).
  setting: SpeakingVoiceInputSchema.optional(),
});

// ─── Un serveur de la personne : ses modèles, et l'état de chaque part (#1048) ─

/**
 * Les modèles qu'un serveur dit à `/models`, lus À L'INSTANT (aucune liste
 * gardée : c'est l'adresse que l'écran montre, peut-être pas encore
 * enregistrée). `models` vide : le serveur répond et ne liste rien ; la
 * personne tape le nom. `unavailable` : il n'a pas répondu, ou a refusé, avec
 * son code (`speech_unreachable`, `speech_provider_error`…) et ses mots.
 */
export const VoiceServerModelsRequestSchema = z.object({
  entityId: z.string().guid(),
  part: z.enum(VOICE_PARTS),
  server: VoiceServerInputSchema,
});
export const VoiceServerModelsSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('listed'),
    models: z.array(z.object({ id: z.string() })),
    listedAt: z.string(),
  }),
  z.object({
    state: z.literal('unavailable'),
    code: z.string().min(1),
    detail: z.string().optional(),
  }),
]);
export type VoiceServerModels = z.infer<typeof VoiceServerModelsSchema>;

/**
 * Le contrôle d'une part, la même épreuve qu'à l'enregistrement : la voix dit
 * « OK. » ; pour la part qui écoute, le modèle doit l'écrire. `speaking` /
 * `listening` absents : la part enregistrée ; présents : celle que l'écran
 * montre. `fresh` : refaire l'épreuve même si une est gardée pour exactement
 * ce réglage (« Check again ») ; sinon la dernière gardée est rendue, avec son
 * heure. Toute source passe par là, pas seulement un serveur.
 */
export const VoiceCheckRequestSchema = z.object({
  entityId: z.string().guid(),
  part: z.enum(VOICE_PARTS),
  speaking: SpeakingVoiceInputSchema.optional(),
  listening: ListeningEarInputSchema.optional(),
  fresh: z.boolean().optional(),
});

/**
 * Ce que l'épreuve a dit. `answers` : le modèle, le temps de la part
 * éprouvée sur l'échantillon, et ce que l'oreille a écrit. `not_answering` :
 * le code (un code de packages/speech ou de ce module) et les mots du
 * serveur ou du fournisseur.
 */
export const VoiceCheckSchema = z.discriminatedUnion('state', [
  z.object({
    part: z.enum(VOICE_PARTS),
    state: z.literal('answers'),
    model: z.string(),
    latencyMs: z.number().int().nonnegative(),
    heard: z.string().optional(),
    checkedAt: z.string(),
  }),
  z.object({
    part: z.enum(VOICE_PARTS),
    state: z.literal('not_answering'),
    code: z.string().min(1),
    detail: z.string().optional(),
    /** What the ear wrote instead of the sample (`transcription_not_faithful`). */
    heard: z.string().optional(),
    model: z.string().optional(),
    checkedAt: z.string(),
  }),
]);
export type VoiceCheck = z.infer<typeof VoiceCheckSchema>;
