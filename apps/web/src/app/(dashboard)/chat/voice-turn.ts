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
// Chaque issue est un FAIT rendu à l'écran, jamais tu (invariant #4) : la
// transcription ratée, le rien-entendu, la voix en échec, le refus.

import { chatFailureText } from '@/lib/chat-failure.ts';

const BASE = '/api/voice/turns';

/** Ce que le runner a rendu d'un tour joué (`VoiceTurnResult`, outcome `replied`). */
export type VoiceReply = {
  transcript: string;
  reply: string;
  durationMs: number;
  spawnedJobId: string | null;
  audio: { mimeType: string; base64: string } | null;
  speechError: { code: string; detail?: string } | null;
};

/** Une étape refusée : où, avec quel statut, et le code tel que la route l'a dit. */
export type VoiceFailure = {
  step: 'start' | 'chunk' | 'end';
  status: number;
  error: string;
  detail?: string;
};

export type VoiceTurnOutcome =
  | { kind: 'replied'; reply: VoiceReply }
  | { kind: 'nothing_heard' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; failure: VoiceFailure };

export interface VoiceTurnSession {
  /** Un morceau de PCM, dans l'ordre de la prise. */
  push(pcm: Uint8Array): void;
  /** Le bouton relâché : les morceaux finissent de partir, puis `end`. */
  finish(): Promise<VoiceTurnOutcome>;
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

    async finish() {
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
        res = await fetch(`${BASE}/${encodeURIComponent(turnId)}/end`, { method: 'POST' });
      } catch {
        return { kind: 'failed', failure: unreachable('end') };
      }
      if (!res.ok) return { kind: 'failed', failure: await readFailure(res, 'end') };
      const body = (await res.json().catch(() => null)) as
        | ({ outcome?: unknown } & Partial<VoiceReply>)
        | null;
      if (body?.outcome === 'nothing_heard') return { kind: 'nothing_heard' };
      if (body?.outcome !== 'replied') {
        return {
          kind: 'failed',
          failure: { step: 'end', status: res.status, error: 'invalid_response' },
        };
      }
      return {
        kind: 'replied',
        reply: {
          transcript: typeof body.transcript === 'string' ? body.transcript : '',
          reply: typeof body.reply === 'string' ? body.reply : '',
          durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
          spawnedJobId: typeof body.spawnedJobId === 'string' ? body.spawnedJobId : null,
          audio: body.audio ?? null,
          speechError: body.speechError ?? null,
        },
      };
    },

    async cancel() {
      cancelled = true;
      await deleteTurn();
      return { kind: 'cancelled' };
    },
  };
}

/** Le texte de l'écran pour une étape refusée — la phrase de chaque code connu. */
export function voiceFailureText(f: VoiceFailure): string {
  switch (f.error) {
    case 'speech_not_configured':
      return 'Voice needs an OpenRouter key. Add one in LLM Providers, then hold the button again.';
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
  if (code === 'speech_not_configured') {
    return 'The reply is written above, but it could not be spoken: voice needs an OpenRouter key.';
  }
  return `The reply is written above, but it could not be spoken (${code}).`;
}
