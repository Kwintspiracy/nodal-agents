'use client';

// voice-turn.ts — un tour DIT, du point de vue du navigateur (#942).
//
// Le client des routes du tour vocal (#941), par la porte web
// (`/api/voice/turns…`), exactement comme un module externe les appelle :
// start, des morceaux numérotés envoyés PENDANT que le bouton est tenu, puis
// end — ou DELETE quand la personne a glissé hors du bouton. Aucune logique
// vocale ici : ce fichier transporte, le runner décide.
//
// LES MORCEAUX PARTENT DANS L'ORDRE, un à la fois. Le runner refuse un morceau
// hors rang (`voice-utterances.ts`) : deux requêtes en vol en même temps
// pourraient arriver à l'envers. Chaque morceau attend donc le précédent ; ce
// qui s'accumule pendant ce temps part au tour suivant de la file.
//
// LA FIN SE LIT EN FLUX (#943). La route répond par des événements, dans
// l'ordre (l'en-tête de apps/runner/src/routes/voice-turn.ts) : la
// transcription dès qu'elle existe, les fragments de la réponse, la voix en
// morceaux numérotés, puis `done`. Ce fichier les passe à l'écran à mesure
// qu'ils arrivent ; c'est `done` qui fait foi pour le texte, comme pour le
// chat écrit (`chat-stream.ts`).
//
// Chaque issue est un FAIT rendu à l'écran, jamais tu (invariant #4) : la
// transcription ratée, le rien-entendu, la voix en échec, le refus, le flux
// coupé.

import { chatFailureText } from '@/lib/chat-failure.ts';
import { readSseMessages } from '@/lib/sse.ts';
import { readSpokenEvent, type SpokenChunk } from './voice-playback.ts';

const BASE = '/api/voice/turns';

/** Ce que le flux a dit d'un tour joué : la transcription, puis `done`. */
export type VoiceReply = {
  transcript: string;
  reply: string;
  durationMs: number;
  spawnedJobId: string | null;
  stopped: boolean;
  speechError: { code: string; detail?: string } | null;
};

/** Ce que la fin du tour passe à l'écran PENDANT qu'elle arrive. */
export interface VoiceStreamHandlers {
  /** Le message de la personne, dès que la transcription existe. */
  onTranscript?: (transcript: string, durationMs: number) => void;
  /** Le texte de la réponse connu À CET INSTANT — entier, pas le fragment. */
  onText?: (text: string) => void;
  /** Un morceau de voix, dans l'ordre de son rang. */
  onAudio?: (chunk: SpokenChunk) => void;
  /** Une phrase est finie (`audio_end`), complète ou non. */
  onAudioEnd?: (sentence: number, complete: boolean) => void;
}

/** Une étape refusée : où, avec quel statut, et le code tel que la route l'a dit. */
export type VoiceFailure = {
  step: 'start' | 'chunk' | 'end';
  status: number;
  error: string;
  detail?: string;
};

export type VoiceTurnOutcome =
  | { kind: 'replied'; reply: VoiceReply }
  /** `model` : le modèle qui n'a rien écrit (#976) ; `null` : rien n'est parti. */
  | { kind: 'nothing_heard'; model: string | null }
  | { kind: 'cancelled' }
  /** La personne a arrêté la réponse : le flux a été abandonné (`abort`). */
  | { kind: 'aborted' }
  | { kind: 'failed'; failure: VoiceFailure };

export interface VoiceTurnSession {
  /** Un morceau de PCM, dans l'ordre de la prise. */
  push(pcm: Uint8Array): void;
  /** Le bouton relâché : les morceaux finissent de partir, puis `end`, lu en flux. */
  finish(handlers?: VoiceStreamHandlers): Promise<VoiceTurnOutcome>;
  /** Stop : la lecture du flux de fin est abandonnée (le runner arrête le tour par son Stop). */
  abort(): void;
  /** Glissé hors du bouton : rien n'est envoyé, le tour est annulé au runner (DELETE). */
  cancel(): Promise<VoiceTurnOutcome>;
}

async function readFailure(res: Response, step: VoiceFailure['step']): Promise<VoiceFailure> {
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    detail?: unknown;
  } | null;
  return {
    step,
    status: res.status,
    error: typeof body?.error === 'string' ? body.error : `http_${String(res.status)}`,
    ...(typeof body?.detail === 'string' ? { detail: body.detail } : {}),
  };
}

function unreachable(step: VoiceFailure['step']): VoiceFailure {
  return { step, status: 0, error: 'runner_unreachable' };
}

/**
 * Ouvre un tour. `conversationId` peut être une promesse : la conversation
 * d'un écran neuf naît au premier geste, et le micro tourne déjà pendant
 * qu'elle s'ouvre — les morceaux attendent le tour dans la file.
 */
export function openVoiceTurn(opts: {
  conversationId: Promise<string> | string;
  sampleRate: number;
  /** Une étape a échoué PENDANT la prise : l'écran arrête d'écouter tout de suite. */
  onFailed?: (failure: VoiceFailure) => void;
}): VoiceTurnSession {
  let failure: VoiceFailure | null = null;
  let cancelled = false;
  const fail = (f: VoiceFailure): void => {
    if (failure !== null) return;
    failure = f;
    opts.onFailed?.(f);
  };

  const started: Promise<string | null> = (async () => {
    let conversationId: string;
    try {
      conversationId = await opts.conversationId;
    } catch (err) {
      fail({
        step: 'start',
        status: 0,
        error: 'conversation_open_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    let res: Response;
    try {
      res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, format: 'audio/pcm', sampleRate: opts.sampleRate }),
      });
    } catch {
      fail(unreachable('start'));
      return null;
    }
    if (!res.ok) {
      fail(await readFailure(res, 'start'));
      return null;
    }
    const body = (await res.json().catch(() => null)) as { turnId?: unknown } | null;
    if (typeof body?.turnId !== 'string') {
      fail({ step: 'start', status: res.status, error: 'invalid_response' });
      return null;
    }
    return body.turnId;
  })();

  let seq = 0;
  let queue: Promise<void> = Promise.resolve();
  const reading = new AbortController();

  const deleteTurn = async (): Promise<void> => {
    const turnId = await started;
    if (turnId === null) return;
    try {
      await fetch(`${BASE}/${encodeURIComponent(turnId)}`, { method: 'DELETE' });
    } catch {
      // Le tour se défait seul au runner après son délai d'inactivité.
    }
  };

  return {
    push(pcm) {
      const n = seq++;
      queue = queue.then(async () => {
        if (failure !== null || cancelled) return;
        const turnId = await started;
        if (turnId === null || cancelled) return;
        let res: Response;
        try {
          res = await fetch(`${BASE}/${encodeURIComponent(turnId)}/chunks/${String(n)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            // Une copie à sa taille : `pcm` peut être la vue d'un tampon plus grand.
            body: pcm.slice().buffer,
          });
        } catch {
          fail(unreachable('chunk'));
          return;
        }
        if (!res.ok) fail(await readFailure(res, 'chunk'));
      });
    },

    async finish(handlers) {
      await queue;
      const turnId = await started;
      if (failure !== null || turnId === null) {
        // Un tour encore ouvert au runner (un morceau refusé hors rang) est
        // fermé : rien de ce qui a été dit ne partira à moitié.
        await deleteTurn();
        return { kind: 'failed', failure: failure ?? unreachable('start') };
      }
      let res: Response;
      try {
        res = await fetch(`${BASE}/${encodeURIComponent(turnId)}/end`, {
          method: 'POST',
          signal: reading.signal,
        });
      } catch {
        if (reading.signal.aborted) return { kind: 'aborted' };
        return { kind: 'failed', failure: unreachable('end') };
      }
      if (!res.ok) return { kind: 'failed', failure: await readFailure(res, 'end') };
      if (res.body === null) {
        return {
          kind: 'failed',
          failure: { step: 'end', status: res.status, error: 'invalid_response' },
        };
      }
      return readEnd(res.body, res.status, handlers ?? {}, reading.signal);
    },

    abort() {
      reading.abort();
    },

    async cancel() {
      cancelled = true;
      await deleteTurn();
      return { kind: 'cancelled' };
    },
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Le flux de fin, lu jusqu'à son dernier événement. */
async function readEnd(
  body: ReadableStream<Uint8Array>,
  status: number,
  handlers: VoiceStreamHandlers,
  signal: AbortSignal,
): Promise<VoiceTurnOutcome> {
  let transcript: string | null = null;
  let durationMs = 0;
  let accumulated = '';
  const broken = (error: string, detail?: string): VoiceTurnOutcome => ({
    kind: 'failed',
    failure: { step: 'end', status, error, ...(detail ? { detail } : {}) },
  });
  try {
    for await (const msg of readSseMessages(body)) {
      const data = JSON.parse(msg.data) as Record<string, unknown>;
      switch (msg.event) {
        case 'nothing_heard':
          return { kind: 'nothing_heard', model: str(data['model']) };
        case 'transcript':
          transcript = str(data['transcript']) ?? '';
          durationMs = typeof data['durationMs'] === 'number' ? data['durationMs'] : 0;
          handlers.onTranscript?.(transcript, durationMs);
          break;
        case 'delta': {
          const text = str(data['text']);
          if (text === null) break;
          accumulated += text;
          handlers.onText?.(accumulated);
          break;
        }
        case 'audio':
        case 'audio_end': {
          // Lu par le lecteur commun aux portes qui parlent (`readSpokenEvent`, #969).
          const spoken = readSpokenEvent(msg.event, data);
          if (!spoken || spoken.kind === 'invalid') return broken('invalid_response');
          if (spoken.kind === 'audio') handlers.onAudio?.(spoken.chunk);
          else handlers.onAudioEnd?.(spoken.sentence, spoken.complete);
          break;
        }
        case 'done': {
          // La réponse entière remplace ce qui a été accumulé, comme au chat écrit.
          const reply = str(data['reply']) ?? '';
          handlers.onText?.(reply);
          const speechError = data['speechError'] as { code?: unknown; detail?: unknown } | null;
          return {
            kind: 'replied',
            reply: {
              transcript: transcript ?? '',
              reply,
              durationMs,
              spawnedJobId: str(data['spawnedJobId']),
              stopped: data['stopped'] === true,
              speechError:
                speechError && typeof speechError.code === 'string'
                  ? {
                      code: speechError.code,
                      ...(typeof speechError.detail === 'string'
                        ? { detail: speechError.detail }
                        : {}),
                    }
                  : null,
            },
          };
        }
        case 'error':
          return broken(str(data['error']) ?? 'chat_failed', str(data['detail']) ?? undefined);
      }
    }
  } catch {
    if (signal.aborted) return { kind: 'aborted' };
    return broken('stream_interrupted');
  }
  if (signal.aborted) return { kind: 'aborted' };
  // Le flux s'est terminé sans `done` : le tour n'a pas rendu de réponse.
  return broken('stream_interrupted');
}

/** Le texte de l'écran pour une étape refusée — la phrase de chaque code connu. */
export function voiceFailureText(f: VoiceFailure): string {
  switch (f.error) {
    // L'oreille de l'espace ne se résout pas (#976) : le code de la résolution.
    case 'voice_key_missing':
      return 'Voice needs an OpenRouter key. Add one in LLM Providers, then hold the button again.';
    case 'voice_key_undecryptable':
      return 'The OpenRouter key could not be read. Enter it again in LLM Providers.';
    case 'voice_setting_missing':
    case 'voice_setting_unreadable':
      return 'No voice is set for this workspace. Choose one in Settings, then hold the button again.';
    case 'audio_too_long':
      return 'That was too long to send. Nothing was sent.';
    case 'transcription_failed':
      return 'Could not transcribe what you said. Nothing was sent.';
    case 'audio_malformed':
      return 'The recording could not be read. Nothing was sent.';
    case 'too_many_open_turns':
      return 'Too many voice turns are open. Try again in a minute.';
    case 'turn_not_found':
      return 'The voice turn expired before it was sent. Hold the button again.';
    case 'runner_unreachable':
      return 'The runner did not answer. Nothing was sent.';
    case 'stream_interrupted':
      // La phrase du chat écrit pour le même fait (`chat-stream.ts`).
      return 'The reply was interrupted';
    case 'conversation_open_failed':
      return `Could not open the conversation${f.detail ? `: ${f.detail}` : ''}. Nothing was sent.`;
    case 'unauthorized':
    case 'forbidden':
    case 'AUTH_REQUIRED':
      return 'Voice was refused: not authorized. Nothing was sent.';
    default:
      if (f.status === 401 || f.status === 403) {
        return 'Voice was refused: not authorized. Nothing was sent.';
      }
      // Passé la transcription, c'est le tour de chat qui a échoué : son
      // vocabulaire est celui du chat écrit.
      if (f.step === 'end') return chatFailureText(f.error, f.detail ?? null);
      return `Voice failed (${f.error}). Nothing was sent.`;
  }
}

/** Le texte de l'écran quand la réponse est écrite mais n'a pas pu être dite. */
export function speechErrorText(code: string): string {
  const lead = 'The reply is written above, but it could not be spoken';
  // #969 : la voix est celle de l'espace (Réglages, Voice) ; ses échecs se
  // disent avec le geste qui les répare.
  switch (code) {
    case 'voice_key_missing':
      return `${lead}: the voice has no key for its source. Add one in LLM Providers, or choose another voice in Settings.`;
    case 'voice_key_undecryptable':
      return `${lead}: the key of the voice could not be read. Enter it again in LLM Providers.`;
    case 'speech_no_credit':
      return `${lead}: the key of the voice has no credit left.`;
    case 'voice_setting_missing':
    case 'voice_setting_unreadable':
      return `${lead}: no voice is set. Choose one in Settings.`;
    default:
      return `${lead} (${code}).`;
  }
}
