// chat/run-voice-turn.ts — un tour DIT : écouter, puis le tour de chat, puis parler (#941, #943).
//
// Le tour vocal n'est pas un second modèle de conversation. C'est le tour du
// tableau de bord (`runChatTurn`, par `playChatTurn`) avec une oreille avant
// et une voix pendant :
//
//   1. `hearVoiceTurn` : l'audio reçu par morceaux (`voice-utterances.ts`) est
//      transcrit par packages/speech, sur la clé OpenRouter de l'espace
//      (`resolveTranscription`). Tout ce qui se refuse se refuse ICI, avant
//      que la route ouvre son flux : un audio illisible, l'espace sans clé, la
//      transcription en échec, et le « rien entendu ». Aucun n'écrit de ligne
//      (invariant #4) : un message vide serait un tour que personne n'a dit ;
//   2. `speakVoiceTurn` : la transcription est le message de la personne,
//      rangé comme DIT, avec sa durée. Le tour garde son unique outil,
//      `run_task` : une question simple reçoit une réponse directe, une
//      demande de travail lance un job avec l'accusé de l'agent. Le tour vocal
//      ne fait jamais le travail lui-même, il ne parle aux jobs que par
//      `run_task` — c'est ce qui permettra à un modèle vocal temps réel de
//      prendre sa place sans toucher au reste ;
//   3. la réponse est DITE PENDANT qu'elle s'écrit (#943). Le tour passe par le
//      chemin en flux de `/api/chat/stream` ; ses fragments sont coupés en
//      phrases (`createSentenceChunker`, packages/speech), et chaque phrase
//      part en voix dès qu'elle est complète (`voice-speech.ts`). La relecture
//      d'escalade (`llm/action-recheck.ts`) ne change jamais le texte : la
//      voix commence avant elle, et elle tourne pendant que la voix parle.
//
// LES SECRETS NE SONT JAMAIS DITS (revue de #968, passes 1 et 2). Les
// fragments arrivent ici déjà masqués par `playChatTurn`, une fois pour tous
// les consommateurs du tour ; le texte écrit d'un bloc et `done.reply` le sont
// par `redactSecretsInText`. Un son ne se reprend pas à la porte. La ligne
// rangée en base reste intacte : le masquage est d'affichage.
//
// Pourquoi ce découpage : mesuré sur la stack du propriétaire le 03/11, 10,1 s
// et 12,1 s du relâchement au premier son, dont 2,9 à 3,7 s pour les deux
// appels de modèle l'un après l'autre et 4,5 à 7 s pour une voix qui rendait la
// réponse ENTIÈRE avant le premier son.
//
// Le job lancé hérite de la forme `spoken` : sa réponse finale est écrite pour
// être dite, et elle est dite quand il finit (#967, chat/job-reply-voice.ts).
//
// LA VOIX est celle que l'espace a choisie (#969) : sa source, son modèle et sa
// voix, relus à chaque tour par `resolveVoice` (job/resolve-voice.ts), la même
// résolution que l'essai des réglages et `generate_speech`. La ligne de temps
// du tour les nomme.
//
// L'origine est une DONNÉE : la conversation du tour, et l'entité qui la
// possède. Rien ici ne demande si l'appelant est le tableau de bord.

import {
  SpeechError,
  createSentenceChunker,
  pcmToWav,
  readWav,
  splitSentences,
} from '@nodal-agents/speech';
import { redactSecretsInText, type VoiceSetting } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveTranscription } from '../job/resolve-speech.ts';
import { resolveVoice } from '../job/resolve-voice.ts';
import { playChatTurn } from './play-turn.ts';
import type { VoiceUtterance } from './voice-utterances.ts';
import { createReplySpeech, type ReplySpeech, type SpeechFailure } from './voice-speech.ts';

/** Ce que l'oreille a rendu. Les codes sont des faits ; l'écran ou le module les dit. */
export type VoiceTurnHearing =
  | { outcome: 'heard'; transcript: string; durationMs: number }
  | { outcome: 'nothing_heard'; durationMs: number }
  | { outcome: 'failed'; status: 400 | 409 | 502; error: string; detail?: string };

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

export async function hearVoiceTurn(
  deps: RunnerDeps,
  u: VoiceUtterance,
): Promise<VoiceTurnHearing> {
  const audio = utteranceAudio(u);
  if (!audio.ok) {
    return { outcome: 'failed', status: 400, error: 'audio_malformed', detail: audio.detail };
  }
  // Aucun échantillon audible : rien n'a été dit, et rien ne part au fournisseur.
  if (audio.durationMs === 0) return { outcome: 'nothing_heard', durationMs: 0 };

  const transcription = await resolveTranscription(deps.db, u.entityId);
  if (!transcription) return { outcome: 'failed', status: 409, error: 'speech_not_configured' };

  try {
    const { text } = await transcription.transcribe({ audio: audio.wav, mimeType: 'audio/wav' });
    return { outcome: 'heard', transcript: text, durationMs: audio.durationMs };
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
}

/**
 * Les temps d'un tour dit, en millisecondes depuis la requête de fin (#943).
 * Une ligne par tour, des nombres seulement — jamais les mots de la personne.
 * C'est la mesure du produit, pour tout client : `null` dit que l'étape n'a
 * pas eu lieu (rien entendu, réponse sans voix).
 */
export const VOICE_TIMING_MARKS = [
  'transcript',
  'firstDelta',
  'firstSentence',
  // Le fournisseur de voix, pour la PREMIÈRE phrase : son premier octet, puis
  // la fin de sa réponse. Proches l'un de l'autre, il rend un fichier ; écartés,
  // il diffuse. C'est ce que la ligne dit de lui, quel qu'il soit.
  'firstSentenceVendorByte',
  'firstSentenceVendorDone',
  'firstAudio',
  'done',
] as const;

/**
 * Les temps de la réponse DITE d'un job (#967), en millisecondes depuis la fin
 * du job (le COMMIT de son statut terminal) : le fournisseur pour la première
 * phrase, puis le premier et le dernier octet de voix sortis. Personne n'y
 * parle : ni transcription, ni fragment.
 */
export const JOB_REPLY_TIMING_MARKS = [
  'firstSentenceVendorByte',
  'firstSentenceVendorDone',
  'firstAudio',
  'lastAudio',
] as const;
export type VoiceTimingMark =
  | (typeof VOICE_TIMING_MARKS)[number]
  | (typeof JOB_REPLY_TIMING_MARKS)[number];

/**
 * La voix d'un tour, dans sa ligne (#969) : la source, le modèle et la voix
 * qui ont parlé — des identifiants, jamais les mots de la personne. C'est ce
 * qui permet de comparer deux voix sur de vrais tours. `null` : la voix n'a
 * pas pu être résolue (la ligne dit alors seulement la source, si elle est
 * connue).
 */
export interface VoiceTimingVoice {
  source: string | null;
  model: string | null;
  voice: string | null;
}

export interface VoiceTiming {
  /** Pose la marque si elle ne l'est pas encore : c'est la PREMIÈRE fois qui compte. */
  mark(name: VoiceTimingMark): void;
  /** Nomme la voix du tour. */
  voice(v: VoiceTimingVoice): void;
  /** La ligne du journal. */
  line(): string;
}

export function createVoiceTiming(
  startedAt: number,
  now: () => number = Date.now,
  /**
   * Le nom de la ligne : `voice-turn` pour un tour, `voice-sample` pour l'essai
   * des réglages, `voice-job-reply` pour la réponse dite d'un job.
   */
  label = 'voice-turn',
  /** Les marques que la ligne écrit, dans cet ordre. */
  marksOfLine: readonly VoiceTimingMark[] = VOICE_TIMING_MARKS,
): VoiceTiming {
  const marks = new Map<VoiceTimingMark, number>();
  let named: VoiceTimingVoice = { source: null, model: null, voice: null };
  return {
    mark(name) {
      if (!marks.has(name)) marks.set(name, now() - startedAt);
    },
    voice(v) {
      named = v;
    },
    line() {
      const ids = (['source', 'model', 'voice'] as const).map(
        (k) => `"${k}":${JSON.stringify(named[k])}`,
      );
      const fields = marksOfLine.map((m) => `"${m}Ms":${String(marks.get(m) ?? null)}`);
      return `[${label}] timing {${[...ids, ...fields].join(',')}}`;
    },
  };
}

/**
 * LA voix d'une réponse dite, pour toute porte qui parle : le tour vocal et
 * l'essai des réglages (« Play a sample ») passent par ici, donc par la même
 * résolution (`resolveVoice`), le même découpage et la même file de phrases
 * (`createReplySpeech`). L'essai entend donc exactement ce que le tour dira.
 *
 * `voice: null` : l'espace ne peut pas parler, et `unavailable` dit pourquoi
 * (pas de clé pour la source, un réglage illisible) — la porte le rend tel
 * quel, jamais remplacé par une autre voix.
 */
export async function openReplyVoice(
  db: RunnerDeps['db'],
  entityId: string,
  emit: VoiceTurnEmit,
  timing: VoiceTiming,
  setting?: VoiceSetting,
): Promise<{
  voice: ReplySpeech | null;
  unavailable: SpeechFailure | null;
  /** La voix qui parle (ou la source qui n'a pas pu), en identifiants. */
  named: VoiceTimingVoice;
}> {
  const resolved = await resolveVoice(db, entityId, setting);
  if (!resolved.ok) {
    const named = { source: resolved.source ?? null, model: null, voice: null };
    timing.voice(named);
    return {
      voice: null,
      named,
      unavailable: {
        code: resolved.code,
        ...(resolved.source || resolved.detail
          ? { detail: [resolved.source, resolved.detail].filter(Boolean).join(': ') }
          : {}),
      },
    };
  }
  const { source, model, voice: voiceId, speech } = resolved.voice;
  const named = { source, model, voice: voiceId };
  timing.voice(named);
  const voice = createReplySpeech({
    speech,
    model,
    voiceId,
    onVendor: (event, sentence) => {
      if (sentence !== 0) return;
      timing.mark(event === 'firstByte' ? 'firstSentenceVendorByte' : 'firstSentenceVendorDone');
    },
    onChunk: (c) => {
      timing.mark('firstAudio');
      emit('audio', {
        seq: c.seq,
        sentence: c.sentence,
        mimeType: c.mimeType,
        ...(c.sampleRate !== undefined ? { sampleRate: c.sampleRate } : {}),
        base64: Buffer.from(c.audio).toString('base64'),
      });
    },
    onSentenceEnd: (sentence, complete) => emit('audio_end', { sentence, complete }),
  });
  return { voice, unavailable: null, named };
}

/** Un événement du flux de la route (voir l'en-tête de routes/voice-turn.ts). */
export type VoiceTurnEmit = (event: string, data: unknown) => void;

/**
 * Le tour joué et dit. Les événements sortent par `emit` dans l'ordre du
 * protocole : `transcript`, des `delta` et des `audio` mêlés, puis `done` —
 * ou `error` si le tour échoue après la transcription. `readerGone` : le
 * lecteur est parti ; la voix se tait (personne ne l'entendrait), le tour va
 * au bout et écrit sa ligne, comme `/api/chat/stream`.
 */
export async function speakVoiceTurn(
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
  u: VoiceUtterance,
  heard: { transcript: string; durationMs: number },
  emit: VoiceTurnEmit,
  opts: { timing: VoiceTiming; readerGone: AbortSignal },
): Promise<void> {
  const { timing } = opts;
  emit('transcript', { transcript: heard.transcript, durationMs: heard.durationMs });
  timing.mark('transcript');

  // La voix de l'espace (#969), relue à chaque tour : un réglage changé vaut
  // dès le tour suivant.
  const opened = await openReplyVoice(deps.db, u.entityId, emit, timing);
  let voice: ReplySpeech | null = opened.voice;
  const silence = (): void => {
    voice?.cancel();
  };
  if (opts.readerGone.aborted) silence();
  opts.readerGone.addEventListener('abort', silence, { once: true });

  const chunker = createSentenceChunker();
  let settled = false;
  let saidAny = false;
  const say = (sentences: string[]): void => {
    for (const s of sentences) {
      timing.mark('firstSentence');
      saidAny = true;
      voice?.say(s);
    }
  };
  /**
   * Le texte de la réponse est connu. Si c'est celui que le flux a dit, la
   * dernière phrase sort du découpeur ; sinon (la relance sans outils l'a
   * écrit d'un bloc), ce que le flux avait mis en voix et qui n'est pas encore
   * sorti est abandonné, et c'est la réponse qui est dite.
   */
  const settle = (text: string, streamed: boolean): void => {
    if (settled) return;
    settled = true;
    if (streamed) say(chunker.flush());
    else {
      voice?.reset();
      say(splitSentences(redactSecretsInText(text)));
    }
    voice?.end();
  };

  let result: Awaited<ReturnType<typeof playChatTurn>>;
  try {
    result = await playChatTurn(
      deps,
      runnerEnv,
      {
        entityId: u.entityId,
        agentId: u.agentId,
        conversationId: u.conversationId,
        message: heard.transcript,
        spoken: { durationMs: heard.durationMs },
        // Déjà masqué (`playChatTurn`) : le texte rendu ET la voix.
        onTextDelta: (delta) => {
          timing.mark('firstDelta');
          emit('delta', { text: delta });
          if (!settled) say(chunker.push(delta));
        },
        onReplyText: ({ text, streamed }) => settle(text, streamed),
      },
      'voiceTurnRoute',
    );
  } catch (err) {
    voice?.cancel();
    opts.readerGone.removeEventListener('abort', silence);
    throw err;
  }

  if (!result.ok) {
    voice?.cancel();
    opts.readerGone.removeEventListener('abort', silence);
    emit('error', {
      error: result.error,
      ...(result.cutReason ? { detail: result.cutReason } : {}),
    });
    return;
  }
  // Une réponse arrêtée par la personne ne se dit plus : elle a demandé le silence.
  if (result.stopped === true) {
    voice?.cancel();
    voice = null;
  } else {
    // Un tour qui n'a pas fixé son texte avant la relecture (un agent en
    // runtime CLI, une réponse coupée par une horloge) le fixe ici.
    settle(result.reply.trim(), result.streamed === true);
  }

  let speechError: SpeechFailure | null = null;
  if (voice) speechError = await voice.done;
  else if (opened.unavailable && saidAny && result.stopped !== true) {
    speechError = opened.unavailable;
  }
  opts.readerGone.removeEventListener('abort', silence);

  emit('done', {
    reply: redactSecretsInText(result.reply),
    spawnedJobId: result.spawnedJobId ?? null,
    streamed: result.streamed === true,
    stopped: result.stopped === true,
    cutReason: result.cutReason ?? null,
    speechError,
  });
}
