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
// LES SECRETS SONT MASQUÉS ICI, avant le texte rendu ET avant la voix (revue
// de #968, passe 1). Une clé citée par l'agent ne sort par aucune porte de ce
// tour — ni le tableau de bord, ni un module (#947) —, et surtout elle n'est
// jamais DITE : un son ne se reprend pas à la porte. Le masqueur de flux
// (`createStreamRedactor`, packages/shared) garde en réserve ce qui pourrait
// encore devenir un secret, jusqu'à l'espace suivante ; la phrase qui le
// suit attend donc au plus un mot de plus. La ligne rangée en base reste
// intacte, comme aux portes du chat écrit : le masquage est d'affichage.
//
// Pourquoi ce découpage : mesuré sur la stack du propriétaire le 03/11, 10,1 s
// et 12,1 s du relâchement au premier son, dont 2,9 à 3,7 s pour les deux
// appels de modèle l'un après l'autre et 4,5 à 7 s pour une voix qui rendait la
// réponse ENTIÈRE avant le premier son.
//
// Le job lancé hérite de la forme `spoken` : sa réponse finale est écrite pour
// être dite (#967 la dira).
//
// L'origine est une DONNÉE : la conversation du tour, et l'entité qui la
// possède. Rien ici ne demande si l'appelant est le tableau de bord.

import {
  SpeechError,
  DEFAULT_GEMINI_VOICE,
  createSentenceChunker,
  pcmToWav,
  readWav,
  splitSentences,
} from '@nodal-agents/speech';
import { createStreamRedactor, redactSecretsInText } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveSpeech, resolveTranscription } from '../job/resolve-speech.ts';
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
export type VoiceTimingMark = (typeof VOICE_TIMING_MARKS)[number];

export interface VoiceTiming {
  /** Pose la marque si elle ne l'est pas encore : c'est la PREMIÈRE fois qui compte. */
  mark(name: VoiceTimingMark): void;
  /** La ligne du journal. */
  line(): string;
}

export function createVoiceTiming(startedAt: number, now: () => number = Date.now): VoiceTiming {
  const marks = new Map<VoiceTimingMark, number>();
  return {
    mark(name) {
      if (!marks.has(name)) marks.set(name, now() - startedAt);
    },
    line() {
      const fields = VOICE_TIMING_MARKS.map((m) => `"${m}Ms":${String(marks.get(m) ?? null)}`);
      return `[voice-turn] timing {${fields.join(',')}}`;
    },
  };
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

  const speech = await resolveSpeech(deps.db, u.entityId);
  let voice: ReplySpeech | null = speech
    ? createReplySpeech({
        speech,
        // La voix que `generate_speech` offre par défaut : un réglage de voix
        // par agent n'existe pas encore, et ce tour n'en invente pas un.
        voiceId: DEFAULT_GEMINI_VOICE,
        onVendor: (event, sentence) => {
          if (sentence !== 0) return;
          timing.mark(
            event === 'firstByte' ? 'firstSentenceVendorByte' : 'firstSentenceVendorDone',
          );
        },
        onChunk: (c) => {
          timing.mark('firstAudio');
          emit('audio', {
            seq: c.seq,
            mimeType: c.mimeType,
            ...(c.sampleRate !== undefined ? { sampleRate: c.sampleRate } : {}),
            base64: Buffer.from(c.audio).toString('base64'),
          });
        },
        onSentenceEnd: (sentence) => emit('audio_end', { sentence }),
      })
    : null;
  const silence = (): void => {
    voice?.cancel();
  };
  if (opts.readerGone.aborted) silence();
  opts.readerGone.addEventListener('abort', silence, { once: true });

  const chunker = createSentenceChunker();
  const redactor = createStreamRedactor();
  /** Le texte masqué part à l'écran ET à la voix, jamais l'un sans l'autre. */
  const out = (safe: string): void => {
    if (safe === '') return;
    emit('delta', { text: safe });
    say(chunker.push(safe));
  };
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
    if (streamed) {
      out(redactor.flush());
      say(chunker.flush());
    } else {
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
        onTextDelta: (delta) => {
          timing.mark('firstDelta');
          if (!settled) out(redactor.push(delta));
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
  else if (!speech && saidAny && result.stopped !== true) {
    speechError = { code: 'speech_not_configured' };
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
