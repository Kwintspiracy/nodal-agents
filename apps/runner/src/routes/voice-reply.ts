// routes/voice-reply.ts — la voix de l'annonce d'un job lancé par la voix (#967).
//
//   GET /api/voice/replies/:audioId?entityId=<uuid>
//     → 200 un flux d'événements (SSE, ci-dessous)
//     → 400 { error: 'invalid_request' }    `entityId` absent ou illisible
//     → 403 { error: 'forbidden' }          l'espace n'est pas celui de l'appelant
//     → 404 { error: 'reply_audio_not_found' }   inconnue, oubliée, ou d'un autre espace
//
// D'OÙ VIENT `audioId`. Du flux des événements (`GET /api/events`,
// routes/events.ts) : quand un job lancé par un tour DIT finit avec un
// résultat, son `job.finished` est suivi, sur le même flux, de
//
//   event: reply.audio   data: { type, jobId, conversationId, audioId }
//
// Ce qui est dit est l'ANNONCE que l'agent écrit pour l'oreille quand le job
// finit (un résultat court, dit ; un document : prêt, où le lire, et l'offre de
// l'envoyer sur un canal joignable) — jamais le résultat lu à voix haute, qui
// reste écrit dans le fil. La règle (qui parle, qui ne parle pas, et pourquoi)
// est dans chat/job-reply-voice.ts. `reply.audio` ne part que si quelqu'un
// écoute la conversation du job (ou tout l'espace) quand il finit : sans
// auditeur, rien n'est produit ni rejoué plus tard.
//
// LE FLUX. Les mêmes événements, aux mêmes formes, que la voix de la fin d'un
// tour dit (l'en-tête de routes/voice-turn.ts) :
//
//   event: audio      data: { seq, sentence, mimeType, sampleRate?, base64 }
//                     la voix, en morceaux NUMÉROTÉS depuis 0, sans trou, à
//                     jouer bout à bout dans l'ordre de `seq` ; `audio/pcm` :
//                     16 bits signés little-endian, mono, à `sampleRate` ; un
//                     autre type ne se décode que par phrase entière
//   event: audio_end  data: { sentence, complete }   la phrase `sentence` est
//                     finie, UNE fois par phrase dont un `audio` est sorti ;
//                     `complete` faux : elle s'est arrêtée en route
//   event: done       data: { text, speechError }   le DERNIER événement ;
//                     `text` : l'annonce dite, masquée de ses secrets (`null` :
//                     elle n'a pas pu s'écrire) ; `speechError` { code,
//                     detail? } : l'annonce n'a pas pu s'écrire
//                     (`announcement_unavailable` l'agent sans modèle,
//                     `announcement_failed` le modèle en échec,
//                     `announcement_empty`), ou la voix a échoué ou n'a pas pu
//                     s'ouvrir (pas de clé pour la source, réglage illisible) —
//                     le résultat, lui, est dans le fil
//
// La voix est produite UNE fois, au runner, pour tous ses lecteurs : un lecteur
// qui ouvre le flux en retard reçoit tout depuis `seq` 0, puis le direct. Elle
// reste lisible `REPLY_AUDIO_KEEP_MS` (2 min) après son `done`, puis 404.
//
// Un client sans écran, de dix lignes :
//
//   for await (const ev of sse(await get(`/api/events?entityId=${entityId}`))) {
//     if (ev.event !== 'reply.audio') continue;
//     for await (const a of sse(await get(`/api/voice/replies/${ev.data.audioId}?entityId=${entityId}`))) {
//       if (a.event === 'audio') speaker.play(a.data);   // dans l'ordre de seq
//       if (a.event === 'done') break;
//     }
//   }
//
// AUTORISATION : la garde du runner, celle de `/api/events` (server.ts), et la
// même règle : l'espace est NOMMÉ par la requête (le web le prend sur la
// session, jamais sur la page) ; un porteur de session n'en nomme que le
// sien. Une voix d'un autre espace répond comme une voix inexistante.

import type { Context } from 'hono';
import { z } from 'zod';
import {
  openReplyAudio,
  replyAudioConversation,
  type ReplyAudioEvent,
} from '../chat/job-reply-voice.ts';
import type { RunnerDeps } from '../deps.ts';
import { callerReachesConversation } from '../devices/device-scope.ts';
import { sseEvent, SSE_HEADERS, subscriptionStream } from './sse.ts';

const QuerySchema = z.object({ entityId: z.string().guid() });

export async function voiceReplyRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const audioId = c.req.param('audioId') ?? '';
  const parsed = QuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId } = parsed.data;
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // Un appareil (#946) n'entend que les annonces de SES conversations ; une
  // autre répond comme une voix inexistante.
  if (c.get('callerDevice')) {
    const of = replyAudioConversation(audioId, entityId);
    if (
      !of ||
      of.conversationId === null ||
      !(await callerReachesConversation(c, deps.db, of.conversationId))
    ) {
      return c.json({ error: 'reply_audio_not_found' }, 404);
    }
  }
  // Inscrit AVANT le flux : une voix inconnue se dit par un 404. Ce qui sort
  // entre l'inscription et l'ouverture du flux attend dans `pending`.
  const pending: ReplyAudioEvent[] = [];
  let forward: (e: ReplyAudioEvent) => void = (e) => {
    pending.push(e);
  };
  const opened = openReplyAudio(audioId, entityId, (e) => forward(e));
  if (!opened) return c.json({ error: 'reply_audio_not_found' }, 404);

  // La fin du flux, quoi qui la cause, passe par `subscriptionStream` (#1033).
  const stream = subscriptionStream(c.req.raw, ({ write, end }) => {
    forward = (e) => {
      write(sseEvent(e.event, e.data));
      if (e.event === 'done') end();
    };
    // Ce qui est déjà sorti, puis le direct (inscrit par `openReplyAudio`).
    for (const e of opened.replayed) forward(e);
    for (const e of pending.splice(0)) forward(e);
    if (opened.ended) end();
    return () => opened.close();
  });
  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
