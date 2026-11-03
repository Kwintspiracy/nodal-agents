// chat/run-voice-turn.ts — un tour DIT : écouter, puis le tour de chat, puis parler (#941).
//
// Le tour vocal n'est pas un second modèle de conversation. C'est le tour du
// tableau de bord (`runChatTurn`, par `playChatTurn`) avec une oreille avant
// et une voix après :
//
//   1. l'audio reçu par morceaux (`voice-utterances.ts`) est transcrit par
//      packages/speech, sur la clé OpenRouter de l'espace (`resolveTranscription`) ;
//   2. la transcription est le message de la personne, rangé comme DIT, avec
//      sa durée. Le tour garde son unique outil, `run_task` : une question
//      simple reçoit une réponse directe, une demande de travail lance un job
//      avec l'accusé de l'agent, et le travail tourne en fond. Le tour vocal ne
//      fait jamais le travail lui-même, il ne parle aux jobs que par `run_task`
//      — c'est ce qui permettra à un modèle vocal temps réel de prendre sa
//      place sans toucher au reste ;
//   3. la réponse est dite (`resolveSpeech`, WAV entier pour l'instant ; le
//      flux viendra avec #943). Le job lancé hérite de la forme `spoken` : sa
//      réponse finale est écrite pour être dite, et passera par le flux de #944.
//
// Ce qui n'est pas un message : un audio sans mots (« rien entendu ») et une
// transcription en échec. Les deux se disent par un code, et aucun n'écrit de
// ligne (invariant #4) : un message vide serait un tour que personne n'a dit.
//
// L'origine est une DONNÉE : la conversation du tour, et l'entité qui la
// possède. Rien ici ne demande si l'appelant est le tableau de bord.

import {
  SpeechError,
  DEFAULT_GEMINI_VOICE,
  pcmToWav,
  readWav,
  type AudioMimeType,
} from '@nodal-agents/speech';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveSpeech, resolveTranscription } from '../job/resolve-speech.ts';
import { playChatTurn } from './play-turn.ts';
import type { VoiceUtterance } from './voice-utterances.ts';

/** Ce que le tour rend. Les codes sont des faits ; l'écran ou le module les dit. */
export type VoiceTurnResult =
  | {
      outcome: 'replied';
      transcript: string;
      durationMs: number;
      /** Les mots de l'agent. Vide : il a lancé un travail sans rien dire. */
      reply: string;
      spawnedJobId: string | null;
      stopped: boolean;
      cutReason: string | null;
      /** La réponse dite, fichier entier (WAV). `null` : aucune réponse à dire, ou `speechError`. */
      audio: { mimeType: AudioMimeType; base64: string } | null;
      /** La voix a échoué APRÈS un tour réussi : le texte reste, l'échec se dit. */
      speechError: { code: string; detail?: string } | null;
    }
  | { outcome: 'nothing_heard'; durationMs: number }
  | { outcome: 'failed'; status: 400 | 404 | 409 | 502; error: string; detail?: string };

/** L'audio du tour en WAV, avec sa durée. Un audio illisible est refusé, jamais deviné. */
function utteranceAudio(
  u: VoiceUtterance,
): { ok: true; wav: Uint8Array; durationMs: number } | { ok: false; detail: string } {
  const all = new Uint8Array(u.bytes);
  let at = 0;
  for (const chunk of u.chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  if (u.format.kind === 'audio/pcm') {
    // 16 bits par échantillon : un nombre impair d'octets est un flux coupé.
    if (all.length % 2 !== 0) {
      return { ok: false, detail: `${all.length} bytes of 16-bit PCM: an odd count` };
    }
    return {
      ok: true,
      wav: pcmToWav(all, { sampleRate: u.format.sampleRate }),
      durationMs: Math.round((all.length / 2 / u.format.sampleRate) * 1000),
    };
  }
  if (all.length === 0) return { ok: true, wav: all, durationMs: 0 };
  try {
    return { ok: true, wav: all, durationMs: readWav(all).durationMs };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runVoiceTurn(
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
  u: VoiceUtterance,
): Promise<VoiceTurnResult> {
  const audio = utteranceAudio(u);
  if (!audio.ok) {
    return { outcome: 'failed', status: 400, error: 'audio_malformed', detail: audio.detail };
  }
  // Aucun échantillon audible : rien n'a été dit, et rien ne part au fournisseur.
  if (audio.durationMs === 0) return { outcome: 'nothing_heard', durationMs: 0 };

  const transcription = await resolveTranscription(deps.db, u.entityId);
  if (!transcription) return { outcome: 'failed', status: 409, error: 'speech_not_configured' };

  let transcript: string;
  try {
    transcript = (await transcription.transcribe({ audio: audio.wav, mimeType: 'audio/wav' })).text;
  } catch (err) {
    if (err instanceof SpeechError && err.code === 'speech_nothing_heard') {
      return { outcome: 'nothing_heard', durationMs: audio.durationMs };
    }
    return {
      outcome: 'failed',
      status: 502,
      error: 'transcription_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const turn = await playChatTurn(
    deps,
    runnerEnv,
    {
      entityId: u.entityId,
      agentId: u.agentId,
      conversationId: u.conversationId,
      message: transcript,
      spoken: { durationMs: audio.durationMs },
    },
    'voiceTurnRoute',
  );
  if (!turn.ok) {
    const notFound = turn.error === 'agent_not_found' || turn.error === 'conversation_not_found';
    return {
      outcome: 'failed',
      status: notFound ? 404 : 400,
      error: turn.error,
      ...(turn.cutReason ? { detail: turn.cutReason } : {}),
    };
  }

  const reply = turn.reply.trim();
  let spoken: { mimeType: AudioMimeType; base64: string } | null = null;
  let speechError: { code: string; detail?: string } | null = null;
  // Une réponse arrêtée par la personne ne se dit pas : elle a demandé le silence.
  if (reply !== '' && turn.stopped !== true) {
    const speech = await resolveSpeech(deps.db, u.entityId);
    if (!speech) {
      speechError = { code: 'speech_not_configured' };
    } else {
      try {
        // La voix que `generate_speech` offre par défaut : un réglage de voix
        // par agent n'existe pas encore, et ce tour n'en invente pas un.
        const out = await speech.synthesize({ text: reply, voiceId: DEFAULT_GEMINI_VOICE });
        spoken = { mimeType: out.mimeType, base64: Buffer.from(out.audio).toString('base64') };
      } catch (err) {
        speechError = {
          code: err instanceof SpeechError ? err.code : 'speech_failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return {
    outcome: 'replied',
    transcript,
    durationMs: audio.durationMs,
    reply: turn.reply,
    spawnedJobId: turn.spawnedJobId ?? null,
    stopped: turn.stopped === true,
    cutReason: turn.cutReason ?? null,
    audio: spoken,
    speechError,
  };
}
