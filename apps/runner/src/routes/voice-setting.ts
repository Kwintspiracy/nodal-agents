// routes/voice-setting.ts — la voix avec laquelle l'espace parle (#969).
//
//   GET  /api/voice/setting?entityId=<uuid>
//        → 200 { setting, settingProblem?, sources }   (`VoiceStateSchema`)
//   PUT  /api/voice/setting   { entityId, setting: { source, model, voice } }
//        → 200 { setting }  |  400 invalid_request  |  409 { error, source?, detail? }
//          (409 aussi quand la voix, essayée, n'a pas parlé : les mots du fournisseur)
//   POST /api/voice/sample    { entityId, text, setting? }
//        → 409 { error, … } avant tout flux, sinon un flux SSE :
//          event: audio  data: { seq, mimeType, sampleRate?, base64 }   comme le tour dit
//          event: done   data: { speechError, source, model, voice }
//
// Le tableau de bord passe par ces routes via son proxy, comme un module
// externe avec son jeton (règle du #948) : rien du réglage ne vit dans Next.
//
// LIRE : la ligne de l'espace, telle que la base la porte, et ce que chaque
// source offre (`voiceChoices`, ses modèles et ses voix lus chez le
// fournisseur, gardés une heure). Une ligne absente ou illisible est dite
// (`settingProblem`), jamais remplacée par une voix supposée.
//
// ÉCRIRE : un réglage n'entre en base que si sa source l'OFFRE, jugé contre la
// liste que la source vient de dire (`voiceRefusal`) : un modèle qu'elle ne
// sert pas, une voix que ce modèle n'offre pas, une source sans clé sont
// refusés avec leur code. Le tour suivant parle avec la nouvelle voix, sans
// redémarrer : chaque porte relit le réglage.
//
// ET SEULEMENT S'IL A PARLÉ (revue de #972, passe 1). Être listé ne suffit
// pas : OpenRouter liste `minimax/speech-2.8-turbo` avec ses voix, et répond
// 400 à sa synthèse (« MiniMax TTS only supports response_format="mp3" »,
// mesuré le 03/11) ; l'API des modèles ne dit aucun format. Avant d'écrire,
// la route fait donc dire une syllabe à la voix candidate, par le chemin même
// du tour (`openReplyVoice`) : une voix qui ne parle pas ici est refusée au
// moment du choix, avec les mots du fournisseur, pour tout client, au lieu de
// faire échouer chaque tour ensuite. Coût : une synthèse courte par
// enregistrement (une ligne `[voice-probe] timing` la mesure).
//
// L'OREILLE (#976), même règle : le modèle de transcription n'entre en base que
// s'il est servi par l'endpoint de transcription d'OpenRouter ET s'il a écrit
// ce que la voix de l'espace vient de dire (la sonde « OK. », la même que
// celle de la voix), par la même résolution que le tour (`resolveEar`,
// chat/transcription-check.ts). Une erreur, un texte vide, autre chose que
// « ok » sont refusés avec ce que le modèle a écrit ; une voix qui ne parle
// pas bloque le contrôle (`transcription_needs_voice`). Aucun audio n'est
// livré avec Nodal. Chaque part n'est contrôlée que si elle CHANGE : changer
// d'oreille ne vérifie pas de nouveau la voix, qui dit pourtant la sonde.
//
// ESSAYER (« Play a sample ») : la phrase de l'appelant, dite par
// `openReplyVoice`, le chemin même du tour vocal. Avec `setting`, c'est la voix
// que l'écran montre avant de l'enregistrer, contrôlée comme une écriture ;
// sans, la voix enregistrée. La phrase vient de l'appelant : le runner n'en
// écrit aucune (invariant #2).
//
// AUTORISATION : la garde du runner (server.ts). Un appelant de confiance (le
// web, qui a cadré l'espace depuis la session) passe ; un porteur de session
// n'atteint que SON espace.

import type { Context } from 'hono';
import { z } from 'zod';
import { readVoiceSetting, writeVoiceSetting } from '@nodal-agents/db';
import {
  VoiceSampleRequestSchema,
  VoiceSettingWriteSchema,
  type SpeakingVoice,
  type VoiceSetting,
  type VoiceState,
} from '@nodal-agents/shared';
import { splitSentences } from '@nodal-agents/speech';
import type { RunnerDeps } from '../deps.ts';
import {
  resolveEar,
  transcriptionChoices,
  transcriptionRefusal,
  voiceChoices,
  voiceRefusal,
} from '../job/resolve-voice.ts';
import { earProbeRefusal, probeAudio, type ProbeAudio } from '../chat/transcription-check.ts';
import type { SpeechFailure } from '../chat/voice-speech.ts';
import { createVoiceTiming, openReplyVoice } from '../chat/run-voice-turn.ts';
import { sseEvent, SSE_HEADERS } from './sse.ts';

const QuerySchema = z.object({ entityId: z.string().guid() });

function ownEntity(c: Context, entityId: string): boolean {
  return Boolean(c.get('callerTrusted')) || c.get('callerEntityId') === entityId;
}

export async function voiceSettingReadRoute(c: Context, deps: Pick<RunnerDeps, 'db'>) {
  const parsed = QuerySchema.safeParse({ entityId: c.req.query('entityId') });
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { entityId } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);

  const [read, sources, transcription] = await Promise.all([
    readVoiceSetting(deps.db, entityId),
    voiceChoices(deps.db, entityId),
    transcriptionChoices(deps.db, entityId),
  ]);
  const state: VoiceState = read.ok
    ? { setting: read.setting, sources, transcription }
    : {
        setting: null,
        settingProblem: { code: read.code, ...(read.detail ? { detail: read.detail } : {}) },
        sources,
        transcription,
      };
  return c.json(state);
}

/** Le refus d'un réglage que sa source n'offre pas, ou `null`. */
async function refusal(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  setting: SpeakingVoice,
): Promise<{ error: string; source?: string; detail?: string } | null> {
  const refused = voiceRefusal(setting, await voiceChoices(deps.db, entityId));
  if (!refused) return null;
  return {
    error: refused.code,
    ...(refused.source ? { source: refused.source } : {}),
    ...(refused.detail ? { detail: refused.detail } : {}),
  };
}

/**
 * Ce que la voix candidate dit pour prouver qu'elle parle ici. Jamais joué,
 * jamais rangé ni montré : ce n'est une phrase pour personne (invariant #2).
 */
export const VOICE_PROBE_TEXT = 'OK.';

type Refusal = { error: string; source?: string; detail?: string };

/**
 * La voix dit la sonde par le chemin du tour (`openReplyVoice`), et l'audio
 * qu'elle a rendu est gardé : c'est lui que le modèle de transcription candidat
 * doit écrire (#976). `failure` : la voix n'a pas parlé, avec ses mots.
 */
async function speakProbe(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  voice: SpeakingVoice,
): Promise<{ failure: SpeechFailure } | { audio: ProbeAudio }> {
  const timing = createVoiceTiming(Date.now(), Date.now, 'voice-probe');
  const chunks: Array<{ bytes: Uint8Array; mimeType: string; sampleRate?: number }> = [];
  const opened = await openReplyVoice(
    deps.db,
    entityId,
    (event, data) => {
      if (event !== 'audio') return;
      const d = data as { base64: string; mimeType: string; sampleRate?: number };
      chunks.push({
        bytes: Uint8Array.from(Buffer.from(d.base64, 'base64')),
        mimeType: d.mimeType,
        ...(d.sampleRate !== undefined ? { sampleRate: d.sampleRate } : {}),
      });
    },
    timing,
    voice,
  );
  let failure = opened.unavailable;
  if (opened.voice) {
    timing.mark('firstSentence');
    opened.voice.say(VOICE_PROBE_TEXT);
    opened.voice.end();
    failure = await opened.voice.done;
  }
  timing.mark('done');
  console.warn(timing.line());
  if (failure) return { failure };
  const audio = probeAudio(chunks);
  if (!audio) {
    return { failure: { code: 'speech_provider_error', detail: `${voice.model} spoke no audio` } };
  }
  return { audio };
}

/**
 * Why the setting cannot be stored, or `null`. The voice and the ear are each
 * checked when they change; both checks share ONE probe (#976): the voice says
 * "OK." and the candidate ear must write it down. Cost: one short synthesis,
 * plus one short transcription when the ear changes.
 */
async function saveRefusal(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  setting: VoiceSetting,
  voiceChanged: boolean,
  earChanged: boolean,
): Promise<Refusal | null> {
  if (!voiceChanged && !earChanged) return null;
  if (voiceChanged) {
    const offered = await refusal(deps, entityId, setting);
    if (offered) return offered;
  }
  if (earChanged) {
    const listed = transcriptionRefusal(
      setting.transcriptionModel,
      await transcriptionChoices(deps.db, entityId),
    );
    if (listed) return refusalOf(listed);
  }
  const spoken = await speakProbe(deps, entityId, setting);
  if ('failure' in spoken) {
    const f = spoken.failure;
    // The ear is tested on what the voice says: a voice that cannot speak
    // blocks the check, said as such, and nothing is accepted untested.
    return voiceChanged
      ? { error: f.code, source: setting.source, ...(f.detail ? { detail: f.detail } : {}) }
      : {
          error: 'transcription_needs_voice',
          source: setting.source,
          detail: f.detail ?? f.code,
        };
  }
  if (!earChanged) return null;
  const ear = await resolveEar(deps.db, entityId, setting.transcriptionModel);
  if (!ear.ok) return refusalOf(ear);
  return earProbeRefusal(ear.ear, spoken.audio);
}

function refusalOf(f: { code: string; source?: string; detail?: string }): Refusal {
  return {
    error: f.code,
    ...(f.source ? { source: f.source } : {}),
    ...(f.detail ? { detail: f.detail } : {}),
  };
}

export async function voiceSettingWriteRoute(c: Context, deps: Pick<RunnerDeps, 'db'>) {
  const parsed = VoiceSettingWriteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, setting } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);
  // Each part is checked when it CHANGES (#976): a save that only changes the
  // ear does not make the voice speak again, and the other way round. A
  // stored row that cannot be read changes everything.
  const stored = await readVoiceSetting(deps.db, entityId);
  const before = stored.ok ? stored.setting : null;
  const voiceChanged =
    before === null ||
    before.source !== setting.source ||
    before.model !== setting.model ||
    before.voice !== setting.voice;
  const earChanged = before === null || before.transcriptionModel !== setting.transcriptionModel;
  const refused = await saveRefusal(deps, entityId, setting, voiceChanged, earChanged);
  if (refused) {
    console.warn(`[voice-setting] refused ${JSON.stringify(refused)}`);
    return c.json(refused, 409);
  }
  await writeVoiceSetting(deps.db, entityId, setting);
  return c.json({ setting });
}

export async function voiceSampleRoute(c: Context, deps: Pick<RunnerDeps, 'db'>) {
  const startedAt = Date.now();
  const parsed = VoiceSampleRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, text, setting } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);
  if (setting) {
    const refused = await refusal(deps, entityId, setting);
    if (refused) return c.json(refused, 409);
  }

  const timing = createVoiceTiming(startedAt, Date.now, 'voice-sample');
  const encoder = new TextEncoder();
  let gone = false;
  let cancelVoice: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        if (gone) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          gone = true;
          cancelVoice?.();
        }
      };
      void (async () => {
        try {
          const opened = await openReplyVoice(deps.db, entityId, send, timing, setting);
          const voice = opened.voice;
          if (voice) {
            cancelVoice = () => voice.cancel();
            if (gone) voice.cancel();
            for (const sentence of splitSentences(text)) {
              timing.mark('firstSentence');
              voice.say(sentence);
            }
            voice.end();
          }
          const speechError = voice ? await voice.done : opened.unavailable;
          send('done', { speechError, ...opened.named });
        } catch (err) {
          console.error('[voiceSampleRoute] sample failed:', err);
          send('error', { error: 'sample_failed' });
        } finally {
          timing.mark('done');
          console.warn(timing.line());
          try {
            controller.close();
          } catch {
            // Déjà fermé par le lecteur.
          }
        }
      })();
    },
    cancel() {
      gone = true;
      cancelVoice?.();
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
