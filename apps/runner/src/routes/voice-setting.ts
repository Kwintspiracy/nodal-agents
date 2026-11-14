// routes/voice-setting.ts — la voix avec laquelle l'espace parle (#969).
//
//   GET  /api/voice/setting?entityId=<uuid>
//        → 200 { setting, settingProblem?, sources, transcription }   (`VoiceStateSchema`)
//          le réglage tel qu'un client le lit : une clé de serveur n'en sort
//          jamais, seulement `hasKey`
//   PUT  /api/voice/setting   { entityId, setting }   (`VoiceSettingInputSchema`)
//        → 200 { setting }  |  400 invalid_request  |  409 { error, source?, detail? }
//          (409 aussi quand la voix, essayée, n'a pas parlé : les mots du fournisseur)
//   POST /api/voice/sample    { entityId, text, setting? }
//        → 409 { error, … } avant tout flux, sinon un flux SSE :
//          event: audio  data: { seq, mimeType, sampleRate?, base64 }   comme le tour dit
//          event: done   data: { speechError, source, model, voice }
//   POST /api/voice/check     { entityId, part, speaking?, listening?, fresh? }   (#1048)
//        → 200 `VoiceCheckSchema` : la part répond (modèle, temps, heure) ou non
//          (code, mots du serveur, heure)
//   POST /api/voice/server/models  { entityId, part, server }   (#1048)
//        → 200 `VoiceServerModelsSchema` : les modèles qu'un serveur de la
//          personne dit à son adresse, lus à l'instant
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
// UN SERVEUR DE LA PERSONNE (#1048) passe par les MÊMES épreuves : son modèle
// est jugé contre ce que le serveur liste (rien listé : le nom tapé est
// essayé), la voix qu'il porte dit la sonde, l'oreille qu'il porte doit
// l'écrire. Sa clé facultative est chiffrée avant tout usage
// (`settingAtRest`) et ne ressort jamais.
//
// L'ÉTAT D'UNE PART (`/api/voice/check`, #1048) : la même épreuve que
// l'enregistrement, pour une part, enregistrée ou à l'écran, quelle que soit
// sa source. La dernière épreuve d'un réglage donné est gardée en mémoire du
// runner (`chat/voice-checks.ts`) avec son heure, et rendue telle quelle
// tant que `fresh` ne demande pas de la refaire : l'écran montre toujours un
// état, daté, sans payer une synthèse à chaque ouverture. Un enregistrement
// réussi garde l'épreuve qu'il vient de passer.
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
  KEYED_VOICE_SOURCES,
  VoiceCheckRequestSchema,
  VoiceSampleRequestSchema,
  VoiceServerModelsRequestSchema,
  VoiceSettingWriteSchema,
  voiceSettingView,
  type ListeningEar,
  type SpeakingVoice,
  type VoiceCheck,
  type VoicePart,
  type VoiceSetting,
  type VoiceState,
} from '@nodal-agents/shared';
import { splitSentences } from '@nodal-agents/speech';
import type { RunnerDeps } from '../deps.ts';
import {
  listeningAtRest,
  resolveEar,
  serverAtRest,
  serverModels,
  serverRefusal,
  settingAtRest,
  speakingAtRest,
  transcriptionChoices,
  transcriptionRefusal,
  voiceChoices,
  voiceRefusal,
} from '../job/resolve-voice.ts';
import { earProbe, probeAudio, type ProbeAudio } from '../chat/transcription-check.ts';
import { keepVoiceCheck, keptVoiceCheck } from '../chat/voice-checks.ts';
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
    ? { setting: voiceSettingView(read.setting), sources, transcription }
    : {
        setting: null,
        settingProblem: { code: read.code, ...(read.detail ? { detail: read.detail } : {}) },
        sources,
        transcription,
      };
  return c.json(state);
}

const isKeyed = (source: string): boolean =>
  (KEYED_VOICE_SOURCES as readonly string[]).includes(source);

/**
 * Le refus d'une voix que sa source n'offre pas, ou `null`. Une source à clé
 * est jugée contre son catalogue ; un serveur de la personne contre ce qu'il
 * liste à son adresse (#1048).
 */
async function refusal(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  setting: SpeakingVoice,
): Promise<{ error: string; source?: string; detail?: string } | null> {
  const refused =
    isKeyed(setting.source) || !setting.speechServer
      ? voiceRefusal(setting, await voiceChoices(deps.db, entityId))
      : serverRefusal(
          'speaking',
          setting.model,
          await serverModels('speaking', setting.speechServer),
        );
  return refused ? refusalOf(refused) : null;
}

/** Le refus d'une oreille que sa source n'offre pas, ou `null`. */
async function earRefusal(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  ear: ListeningEar,
): Promise<Refusal | null> {
  const refused =
    isKeyed(ear.transcriptionSource) || !ear.transcriptionServer
      ? transcriptionRefusal(ear.transcriptionModel, await transcriptionChoices(deps.db, entityId))
      : serverRefusal(
          'listening',
          ear.transcriptionModel,
          await serverModels('listening', ear.transcriptionServer),
        );
  return refused ? refusalOf(refused) : null;
}

/**
 * Ce que la voix candidate dit pour prouver qu'elle parle ici. Jamais joué,
 * jamais rangé ni montré : ce n'est une phrase pour personne (invariant #2).
 */
export const VOICE_PROBE_TEXT = 'OK.';

type Refusal = { error: string; source?: string; detail?: string; heard?: string };

/**
 * La voix dit la sonde par le chemin du tour (`openReplyVoice`), et l'audio
 * qu'elle a rendu est gardé : c'est lui que le modèle de transcription candidat
 * doit écrire (#976). `failure` : la voix n'a pas parlé, avec ses mots.
 */
async function speakProbe(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  voice: SpeakingVoice,
): Promise<{ failure: SpeechFailure } | { audio: ProbeAudio; latencyMs: number }> {
  const startedAt = Date.now();
  const timing = createVoiceTiming(startedAt, Date.now, 'voice-probe');
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
  return { audio, latencyMs: Date.now() - startedAt };
}

/** What one part's trial gave: it answers, or why it does not. */
type PartTrial =
  | { ok: true; model: string; latencyMs: number; heard?: string }
  | ({ ok: false; model: string } & Refusal);

/**
 * The trial of the parts named (#976, #1048), the SAME for a save and for a
 * check, whatever the sources: each part's model is judged against what its
 * source offers, then ONE probe: the voice says "OK." and the ear, when it is
 * tried, must write it down. Cost: one short synthesis, plus one short
 * transcription when the ear is tried. A part that fails stops the trial
 * there: what comes after it was not tried, and is not said to answer.
 */
async function trial(
  deps: Pick<RunnerDeps, 'db'>,
  entityId: string,
  speaking: SpeakingVoice,
  ear: ListeningEar,
  parts: { speaking: boolean; listening: boolean },
): Promise<{ speaking?: PartTrial; listening?: PartTrial }> {
  const out: { speaking?: PartTrial; listening?: PartTrial } = {};
  if (!parts.speaking && !parts.listening) return out;
  if (parts.speaking) {
    const offered = await refusal(deps, entityId, speaking);
    if (offered) return { speaking: { ok: false, model: speaking.model, ...offered } };
  }
  if (parts.listening) {
    const listed = await earRefusal(deps, entityId, ear);
    if (listed) return { listening: { ok: false, model: ear.transcriptionModel, ...listed } };
  }
  const spoken = await speakProbe(deps, entityId, speaking);
  if ('failure' in spoken) {
    const f = spoken.failure;
    // The ear is tested on what the voice says: a voice that cannot speak
    // blocks the check, said as such, and nothing is accepted untested.
    return parts.speaking
      ? {
          speaking: {
            ok: false,
            model: speaking.model,
            error: f.code,
            source: speaking.source,
            ...(f.detail ? { detail: f.detail } : {}),
          },
        }
      : {
          listening: {
            ok: false,
            model: ear.transcriptionModel,
            error: 'transcription_needs_voice',
            source: speaking.source,
            detail: f.detail ?? f.code,
          },
        };
  }
  if (parts.speaking)
    out.speaking = { ok: true, model: speaking.model, latencyMs: spoken.latencyMs };
  if (!parts.listening) return out;
  const resolved = await resolveEar(deps.db, entityId, ear);
  if (!resolved.ok) {
    out.listening = { ok: false, model: ear.transcriptionModel, ...refusalOf(resolved) };
    return out;
  }
  const probed = await earProbe(resolved.ear, spoken.audio);
  out.listening = probed.ok
    ? { ok: true, model: ear.transcriptionModel, latencyMs: probed.latencyMs, heard: probed.heard }
    : { ok: false, model: ear.transcriptionModel, ...probed.refusal };
  return out;
}

/** A trial as a check a client reads. */
function checkOf(part: VoicePart, t: PartTrial, at: Date): VoiceCheck {
  return t.ok
    ? {
        part,
        state: 'answers',
        model: t.model,
        latencyMs: t.latencyMs,
        ...(t.heard !== undefined ? { heard: t.heard } : {}),
        checkedAt: at.toISOString(),
      }
    : {
        part,
        state: 'not_answering',
        code: t.error,
        ...(t.detail ? { detail: t.detail } : {}),
        ...(t.heard !== undefined ? { heard: t.heard } : {}),
        model: t.model,
        checkedAt: at.toISOString(),
      };
}

/** The ear of a setting, as its own part. */
function earOf(s: VoiceSetting): ListeningEar {
  return {
    transcriptionSource: s.transcriptionSource,
    transcriptionModel: s.transcriptionModel,
    ...(s.transcriptionServer ? { transcriptionServer: s.transcriptionServer } : {}),
  };
}

/** The voice of a setting, as its own part. */
function voiceOf(s: VoiceSetting): SpeakingVoice {
  return {
    source: s.source,
    model: s.model,
    voice: s.voice,
    ...(s.speechServer ? { speechServer: s.speechServer } : {}),
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
  const { entityId } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);
  // Each part is checked when it CHANGES (#976): a save that only changes the
  // ear does not make the voice speak again, and the other way round. A
  // stored row that cannot be read changes everything. A server's address or
  // key is part of what changes (#1048).
  const stored = await readVoiceSetting(deps.db, entityId);
  const before = stored.ok ? stored.setting : null;
  const atRest = settingAtRest(parsed.data.setting, before);
  if (!atRest.ok) return c.json({ error: atRest.code, detail: atRest.detail }, 409);
  const setting = atRest.value;
  const voiceChanged = before === null || !sameJson(voiceOf(before), voiceOf(setting));
  const earChanged = before === null || !sameJson(earOf(before), earOf(setting));
  const tried = await trial(deps, entityId, voiceOf(setting), earOf(setting), {
    speaking: voiceChanged,
    listening: earChanged,
  });
  const failed = [tried.speaking, tried.listening].find((t) => t && !t.ok);
  if (failed && !failed.ok) {
    const refused: Refusal = {
      error: failed.error,
      ...(failed.source ? { source: failed.source } : {}),
      ...(failed.detail ? { detail: failed.detail } : {}),
      ...(failed.heard !== undefined ? { heard: failed.heard } : {}),
    };
    console.warn(`[voice-setting] refused ${JSON.stringify(refused)}`);
    return c.json(refused, 409);
  }
  await writeVoiceSetting(deps.db, entityId, setting);
  // The trial just passed is the parts' state: the screen shows it as checked.
  const at = new Date();
  if (tried.speaking) {
    keepVoiceCheck(entityId, 'speaking', setting, checkOf('speaking', tried.speaking, at));
  }
  if (tried.listening) {
    keepVoiceCheck(entityId, 'listening', setting, checkOf('listening', tried.listening, at));
  }
  return c.json({ setting: voiceSettingView(setting) });
}

/**
 * The state of one part (#1048): the trial of a save, for the part as stored
 * or as the screen shows it. The last trial of exactly that setting is kept,
 * dated, and returned until `fresh` asks for a new one.
 */
export async function voiceCheckRoute(c: Context, deps: Pick<RunnerDeps, 'db'>) {
  const parsed = VoiceCheckRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, part, fresh } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);
  const stored = await readVoiceSetting(deps.db, entityId);
  const before = stored.ok ? stored.setting : null;
  const at = new Date();
  // A part not sent is the stored one; with nothing stored, there is nothing to try.
  let speaking: SpeakingVoice | null = before ? voiceOf(before) : null;
  if (parsed.data.speaking) {
    const r = speakingAtRest(parsed.data.speaking, before);
    if (!r.ok) return c.json({ error: r.code, detail: r.detail }, 409);
    speaking = r.value;
  }
  let ear: ListeningEar | null = before ? earOf(before) : null;
  if (parsed.data.listening) {
    const r = listeningAtRest(parsed.data.listening, before);
    if (!r.ok) return c.json({ error: r.code, detail: r.detail }, 409);
    ear = r.value;
  }
  if (!speaking || !ear) {
    const code = stored.ok ? 'voice_setting_missing' : stored.code;
    return c.json({
      part,
      state: 'not_answering',
      code,
      checkedAt: at.toISOString(),
    } satisfies VoiceCheck);
  }
  const setting = { ...speaking, ...ear } as VoiceSetting;
  if (!fresh) {
    const kept = keptVoiceCheck(entityId, part, setting);
    if (kept) return c.json(kept);
  }
  const tried = await trial(deps, entityId, speaking, ear, {
    speaking: part === 'speaking',
    listening: part === 'listening',
  });
  const t = part === 'speaking' ? tried.speaking : tried.listening;
  if (!t) throw new Error(`the trial of ${part} returned nothing for ${part}`);
  const check = checkOf(part, t, at);
  keepVoiceCheck(entityId, part, setting, check);
  if (check.state === 'not_answering') {
    console.warn(`[voice-check] ${JSON.stringify({ part, code: check.code, model: check.model })}`);
  }
  return c.json(check);
}

/**
 * The models a server of the person's lists (#1048), at the address the
 * screen shows, read now. Its key goes through `serverAtRest`, like a save.
 */
export async function voiceServerModelsRoute(c: Context, deps: Pick<RunnerDeps, 'db'>) {
  const parsed = VoiceServerModelsRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, part, server } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);
  const stored = await readVoiceSetting(deps.db, entityId);
  const before = stored.ok ? stored.setting : null;
  const storedServer = before
    ? part === 'speaking'
      ? before.speechServer
      : before.transcriptionServer
    : undefined;
  const atRest = serverAtRest(server, storedServer);
  if (!atRest.ok) return c.json({ error: atRest.code, detail: atRest.detail }, 409);
  return c.json(await serverModels(part, atRest.server));
}

export async function voiceSampleRoute(c: Context, deps: Pick<RunnerDeps, 'db'>) {
  const startedAt = Date.now();
  const parsed = VoiceSampleRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, text } = parsed.data;
  if (!ownEntity(c, entityId)) return c.json({ error: 'entity_not_found' }, 404);
  let setting: SpeakingVoice | undefined;
  if (parsed.data.setting) {
    const stored = await readVoiceSetting(deps.db, entityId);
    const atRest = speakingAtRest(parsed.data.setting, stored.ok ? stored.setting : null);
    if (!atRest.ok) return c.json({ error: atRest.code, detail: atRest.detail }, 409);
    setting = atRest.value;
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
