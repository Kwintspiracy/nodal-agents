// resolve-voice.ts — LA voix avec laquelle l'espace parle, résolue une fois,
// pour toute porte qui parle (#969).
//
// Le réglage de l'espace (`entity_settings`, clé `voice`, posé pour tout espace
// par la migration 0158) dit la source, le modèle et la voix. Toute porte qui
// parle le lit ICI, et nulle part ailleurs :
//   - le tour vocal, qui sert tout client (tableau de bord, module externe) ;
//   - « Play a sample » des réglages, qui passe par le même chemin que le tour ;
//   - le défaut de `generate_speech` (ses paramètres `model` et `voice`
//     explicites gagnent toujours).
// Un réglage changé vaut pour le tour suivant : il est relu à chaque fois,
// sans cache et sans redémarrage.
//
// Rien n'est remplacé en silence (invariant #4) : une ligne absente ou
// illisible, une source sans clé, une clé illisible rendent un échec codé, que
// la porte dit. Le crédit épuisé et la voix refusée par le fournisseur sont
// dits par la synthèse elle-même (`speech_no_credit`, les mots du
// fournisseur).
//
// LES CHOIX viennent des fournisseurs (`voiceChoices`) : les modèles de
// l'API d'OpenRouter avec leurs `supported_voices`, les modèles TTS de l'API de
// Google avec les voix préconstruites de Gemini. Gardés UNE HEURE par runner
// (`VOICE_CATALOG_TTL_MS`) : un nouveau modèle apparaît dans l'heure, et
// l'écran ne paie pas un aller-retour au fournisseur à chaque ouverture. Une
// liste en échec n'est jamais gardée.

import { createHash } from 'node:crypto';
import {
  and,
  desc,
  eq,
  entityLlmKeys,
  readVoiceSetting,
  type AnyDrizzleDb,
} from '@nodal-agents/db';
import { providerFetch } from '@nodal-agents/llm';
import { decrypt } from '@nodal-agents/secrets';
import {
  VOICE_SOURCES,
  type TranscriptionChoices,
  type VoiceFailureCode,
  type SpeakingVoice,
  type VoiceSource,
  type VoiceSourceChoices,
} from '@nodal-agents/shared';
import {
  bindSpeech,
  bindTranscription,
  getSpeechAdapter,
  getTranscriptionAdapter,
  type BoundSpeech,
  type BoundTranscription,
  type TranscriptionModelOffer,
  type SpeechConnection,
  type SpeechModelOffer,
} from '@nodal-agents/speech';

/** La voix prête à parler : le réglage, et l'adaptateur de sa source lié à sa clé. */
export interface WorkspaceVoice {
  source: VoiceSource;
  model: string;
  voice: string;
  speech: BoundSpeech;
}

export interface VoiceFailure {
  code: VoiceFailureCode;
  /** La source concernée, quand l'échec en vient. */
  source?: VoiceSource;
  /** Les mots de la base ou du fournisseur. */
  detail?: string;
}

export type VoiceResolution = { ok: true; voice: WorkspaceVoice } | ({ ok: false } & VoiceFailure);

/**
 * La clé active la plus récente de l'espace pour cette source.
 *
 * L'adresse enregistrée avec une clé OpenRouter (un proxy) est sa racine, et
 * suit la clé. Celle d'une clé Google est la surface de chat de son SDK : elle
 * n'est pas passée, l'adaptateur parle à la racine documentée de Google (même
 * règle que MiniMax, voir `SpeechConnection.baseURL`).
 */
async function sourceConnection(
  db: AnyDrizzleDb,
  entityId: string,
  source: VoiceSource,
): Promise<{ ok: true; connection: SpeechConnection } | ({ ok: false } & VoiceFailure)> {
  const [row] = await db
    .select({ apiKey: entityLlmKeys.apiKey, baseUrl: entityLlmKeys.baseUrl })
    .from(entityLlmKeys)
    .where(
      and(
        eq(entityLlmKeys.entityId, entityId),
        eq(entityLlmKeys.provider, source),
        eq(entityLlmKeys.isActive, true),
      ),
    )
    .orderBy(desc(entityLlmKeys.createdAt))
    .limit(1);
  if (!row?.apiKey) return { ok: false, code: 'voice_key_missing', source };
  let apiKey: string;
  try {
    apiKey = decrypt(row.apiKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[resolveVoice] ${source} key undecryptable: ${detail}`);
    return { ok: false, code: 'voice_key_undecryptable', source, detail: detail.slice(0, 120) };
  }
  return {
    ok: true,
    connection: {
      apiKey,
      fetch: providerFetch,
      ...(source === 'openrouter' && row.baseUrl ? { baseURL: row.baseUrl } : {}),
    },
  };
}

/**
 * La voix de l'espace. `setting` : un réglage à essayer AVANT de l'enregistrer
 * (« Play a sample » sur ce que l'écran montre) ; il passe par la même
 * résolution, la même clé et le même adaptateur que le réglage enregistré.
 */
export async function resolveVoice(
  db: AnyDrizzleDb,
  entityId: string | null,
  setting?: SpeakingVoice,
): Promise<VoiceResolution> {
  if (entityId === null) return { ok: false, code: 'voice_setting_missing' };
  let chosen = setting;
  if (!chosen) {
    const read = await readVoiceSetting(db, entityId);
    if (!read.ok)
      return { ok: false, code: read.code, ...(read.detail ? { detail: read.detail } : {}) };
    chosen = read.setting;
  }
  const conn = await sourceConnection(db, entityId, chosen.source);
  if (!conn.ok) return conn;
  return {
    ok: true,
    voice: {
      source: chosen.source,
      model: chosen.model,
      voice: chosen.voice,
      speech: bindSpeech(getSpeechAdapter(chosen.source), conn.connection),
    },
  };
}

// ─── Les choix ───────────────────────────────────────────────────────────────

/** Combien de temps un runner garde la liste d'une source. */
export const VOICE_CATALOG_TTL_MS = 60 * 60 * 1000;

type Listed = { models: readonly SpeechModelOffer[]; listedAt: Date };
const catalog = new Map<string, Listed>();

/** Vider la liste gardée — pour les tests. */
export function clearVoiceCatalog(): void {
  catalog.clear();
  earCatalog.clear();
}

/** La liste gardée appartient à la source, à son adresse et à SA clé, jamais à une autre. */
function catalogKey(source: VoiceSource, connection: SpeechConnection): string {
  const key = createHash('sha256').update(connection.apiKey).digest('hex').slice(0, 16);
  return `${source}|${connection.baseURL ?? ''}|${key}`;
}

async function listedModels(
  source: VoiceSource,
  connection: SpeechConnection,
  now: () => number,
): Promise<Listed> {
  const k = catalogKey(source, connection);
  const kept = catalog.get(k);
  if (kept && now() - kept.listedAt.getTime() < VOICE_CATALOG_TTL_MS) return kept;
  const adapter = getSpeechAdapter(source);
  if (!adapter.listModels) {
    throw new Error(`the ${source} speech adapter cannot list its models`);
  }
  const listed = { models: await adapter.listModels(connection), listedAt: new Date(now()) };
  catalog.set(k, listed);
  return listed;
}

/** Ce que chaque source offre à l'espace, ou pourquoi elle ne l'offre pas. */
export async function voiceChoices(
  db: AnyDrizzleDb,
  entityId: string,
  now: () => number = Date.now,
): Promise<VoiceSourceChoices[]> {
  return Promise.all(
    VOICE_SOURCES.map(async (source): Promise<VoiceSourceChoices> => {
      const conn = await sourceConnection(db, entityId, source);
      if (!conn.ok) {
        return {
          source,
          state: 'unavailable',
          code: conn.code,
          ...(conn.detail ? { detail: conn.detail } : {}),
        };
      }
      try {
        const listed = await listedModels(source, conn.connection, now);
        return {
          source,
          state: 'available',
          models: listed.models.map((m) => ({
            id: m.id,
            label: m.label,
            voices: m.voices.map((v) => ({
              id: v.id,
              label: v.label,
              ...(v.description ? { description: v.description } : {}),
            })),
          })),
          listedAt: listed.listedAt.toISOString(),
          cacheSeconds: VOICE_CATALOG_TTL_MS / 1000,
        };
      } catch (err) {
        return {
          source,
          state: 'unavailable',
          code: 'voice_catalog_unreachable',
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        };
      }
    }),
  );
}

/**
 * Le réglage est-il OFFERT par sa source ? Jugé contre la liste que la source
 * a dite, jamais contre une liste du code : un modèle que la source ne sert
 * pas, ou une voix que CE modèle n'offre pas, est refusé avec son code.
 */
export function voiceRefusal(
  setting: SpeakingVoice,
  choices: readonly VoiceSourceChoices[],
): VoiceFailure | null {
  const src = choices.find((c) => c.source === setting.source);
  if (!src) return { code: 'voice_key_missing', source: setting.source };
  if (src.state === 'unavailable') {
    return {
      code: src.code,
      source: setting.source,
      ...(src.detail ? { detail: src.detail } : {}),
    };
  }
  const model = src.models.find((m) => m.id === setting.model);
  if (!model) {
    return { code: 'voice_model_not_offered', source: setting.source, detail: setting.model };
  }
  if (!model.voices.some((v) => v.id === setting.voice)) {
    return {
      code: 'voice_not_offered',
      source: setting.source,
      detail: `${setting.model} offers ${
        model.voices.length === 0 ? 'no voice' : model.voices.map((v) => v.id).join(', ')
      }`.slice(0, 300),
    };
  }
  return null;
}

// ─── L'oreille (#976) ────────────────────────────────────────────────────────
//
// Le modèle qui transcrit les tours dits est le même réglage (`transcriptionModel`),
// relu par la même résolution, sur la clé OpenRouter de l'espace : la
// transcription passe par l'endpoint de transcription d'OpenRouter
// (`/audio/transcriptions`, packages/speech). Avant #976 elle passait par un
// modèle de chat que rien ne permettait de choisir.

/** L'oreille prête à transcrire : le modèle du réglage, et l'adaptateur lié à la clé. */
export interface WorkspaceEar {
  model: string;
  transcription: BoundTranscription;
}

export type EarResolution = { ok: true; ear: WorkspaceEar } | ({ ok: false } & VoiceFailure);

/**
 * L'oreille de l'espace. `model` : un modèle à essayer AVANT de l'enregistrer
 * (le contrôle d'un enregistrement) ; il passe par la même clé et le même
 * adaptateur que le modèle enregistré.
 */
export async function resolveEar(
  db: AnyDrizzleDb,
  entityId: string | null,
  model?: string,
): Promise<EarResolution> {
  if (entityId === null) return { ok: false, code: 'voice_setting_missing' };
  let chosen = model;
  if (!chosen) {
    const read = await readVoiceSetting(db, entityId);
    if (!read.ok) {
      return { ok: false, code: read.code, ...(read.detail ? { detail: read.detail } : {}) };
    }
    chosen = read.setting.transcriptionModel;
  }
  const conn = await sourceConnection(db, entityId, 'openrouter');
  if (!conn.ok) return conn;
  return {
    ok: true,
    ear: {
      model: chosen,
      transcription: bindTranscription(getTranscriptionAdapter('openrouter'), conn.connection),
    },
  };
}

type ListedEar = { models: readonly TranscriptionModelOffer[]; listedAt: Date };
const earCatalog = new Map<string, ListedEar>();

/** Ce que l'endpoint de transcription offre à l'espace, ou pourquoi il ne l'offre pas. */
export async function transcriptionChoices(
  db: AnyDrizzleDb,
  entityId: string,
  now: () => number = Date.now,
): Promise<TranscriptionChoices> {
  const conn = await sourceConnection(db, entityId, 'openrouter');
  if (!conn.ok) {
    return {
      state: 'unavailable',
      code: conn.code,
      ...(conn.detail ? { detail: conn.detail } : {}),
    };
  }
  const k = catalogKey('openrouter', conn.connection);
  try {
    let listed = earCatalog.get(k);
    if (!listed || now() - listed.listedAt.getTime() >= VOICE_CATALOG_TTL_MS) {
      const adapter = getTranscriptionAdapter('openrouter');
      if (!adapter.listModels)
        throw new Error('the openrouter transcription adapter cannot list its models');
      listed = { models: await adapter.listModels(conn.connection), listedAt: new Date(now()) };
      earCatalog.set(k, listed);
    }
    return {
      state: 'available',
      models: listed.models.map((m) => ({ id: m.id, label: m.label })),
      listedAt: listed.listedAt.toISOString(),
      cacheSeconds: VOICE_CATALOG_TTL_MS / 1000,
    };
  } catch (err) {
    return {
      state: 'unavailable',
      code: 'voice_catalog_unreachable',
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

/** Le modèle de transcription est-il servi par l'endpoint ? `null` : oui. */
export function transcriptionRefusal(
  model: string,
  choices: TranscriptionChoices,
): VoiceFailure | null {
  if (choices.state === 'unavailable') {
    return {
      code: choices.code,
      source: 'openrouter',
      ...(choices.detail ? { detail: choices.detail } : {}),
    };
  }
  if (!choices.models.some((m) => m.id === model)) {
    return { code: 'transcription_model_not_offered', source: 'openrouter', detail: model };
  }
  return null;
}
