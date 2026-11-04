'use client';

// job-reply-voice.ts — l'annonce d'un job lancé par la voix, jouée quand il
// finit (#967), du point de vue du navigateur.
//
// Le résultat du job est dans le fil, écrit pour être lu. Ce qui se joue est
// l'ANNONCE que l'agent écrit pour l'oreille quand le job finit. Le runner
// pousse `reply.audio` sur le flux des événements, juste après le
// `job.finished` du job : un POINTEUR. La voix se lit sur
// `/api/voice/replies/:audioId` (la porte web de la route du runner, dont
// l'en-tête décrit le protocole), exactement comme un module sans écran la lit,
// et elle joue par la lecture de #964, APRÈS la voix qui parle déjà
// (`queueSpokenStream`) : une réponse en cours n'est jamais coupée.
//
// Chaque échec est un FAIT dit à l'écran (invariant #4), jamais tu : la voix
// refusée ou oubliée par le runner, le flux coupé, l'annonce que l'agent n'a
// pas pu écrire, la voix en échec. Le résultat, lui, est déjà écrit dans le fil.

import { readSseMessages } from '@/lib/sse.ts';
import { queueSpokenStream, readSpokenEvent } from './voice-playback.ts';
import { speechErrorText } from './voice-turn.ts';

export type JobReplyVoiceFailure = { text: string; detail?: string };

/** Ce que le runner a dit en refusant la voix, en mots de l'écran. */
function refusalText(status: number, error: string): string {
  const lead = 'The reply is written above, but it could not be spoken';
  if (error === 'reply_audio_not_found') return `${lead}: its voice is no longer available.`;
  if (error === 'runner_unreachable') return `${lead}: the runner did not answer.`;
  return `${lead} (${error || `http_${String(status)}`}).`;
}

/**
 * Joue la voix `audioId`, après celle qui parle. `reply` : le texte de la
 * réponse, celui que la pastille « Speaking » désigne. `onFailed` : la voix
 * n'a pas été jouée en entier, et pourquoi.
 */
export async function playJobReply(opts: {
  audioId: string;
  reply: string;
  onFailed: (failure: JobReplyVoiceFailure) => void;
  signal?: AbortSignal;
}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/voice/replies/${encodeURIComponent(opts.audioId)}`, {
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    if (opts.signal?.aborted) return;
    opts.onFailed({ text: refusalText(0, 'runner_unreachable') });
    return;
  }
  if (!res.ok || res.body === null) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    opts.onFailed({
      text: refusalText(res.status, typeof body?.error === 'string' ? body.error : ''),
    });
    return;
  }

  const voice = queueSpokenStream({
    reply: opts.reply,
    onError: (message) =>
      opts.onFailed({
        text: 'The reply is written above, but it could not be played.',
        detail: message,
      }),
  });
  try {
    for await (const msg of readSseMessages(res.body)) {
      const data = JSON.parse(msg.data) as Record<string, unknown>;
      if (msg.event === 'done') {
        const err = data['speechError'] as { code?: unknown; detail?: unknown } | null;
        if (err && typeof err.code === 'string') {
          opts.onFailed({
            text: err.code.startsWith('announcement_')
              ? 'The result is written above, but its spoken announcement could not be written.'
              : speechErrorText(err.code),
            ...(typeof err.detail === 'string' ? { detail: err.detail } : {}),
          });
        }
        voice.end();
        return;
      }
      const spoken = readSpokenEvent(msg.event, data);
      if (spoken === null) continue;
      if (spoken.kind === 'invalid') {
        voice.end();
        opts.onFailed({ text: refusalText(res.status, 'invalid_response') });
        return;
      }
      if (spoken.kind === 'audio') voice.push(spoken.chunk);
      else voice.endSentence(spoken.sentence, spoken.complete);
    }
  } catch {
    voice.end();
    if (opts.signal?.aborted) return;
    opts.onFailed({ text: refusalText(res.status, 'stream_interrupted') });
    return;
  }
  // Le flux s'est terminé sans `done` : ce qui est arrivé joue, la coupure se dit.
  voice.end();
  opts.onFailed({ text: refusalText(res.status, 'stream_interrupted') });
}
