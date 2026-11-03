// routes/voice-turn.ts — le geste `say` : un tour dit, reçu par morceaux (#941),
// sa réponse rendue en flux, phrase par phrase (#943).
//
//   POST   /api/voice/turns                       { entityId, conversationId, format, sampleRate? }
//                                                 → 201 { turnId }
//   POST   /api/voice/turns/:turnId/chunks/:seq   corps = octets audio bruts → 200 { received }
//   POST   /api/voice/turns/:turnId/end           → 200 un flux d'événements (SSE, ci-dessous)
//   DELETE /api/voice/turns/:turnId               → 200 { cancelled }   (le geste `cancel`)
//
// Pourquoi trois requêtes et pas un corps en flux : voir chat/voice-utterances.ts.
//
// LA FIN DU TOUR (#943). Tout ce qui se refuse est refusé AVANT le flux, en
// JSON avec son statut, comme toute autre route : `turn_not_found` 404,
// `audio_malformed` 400, 409 quand l'espace n'a pas d'oreille (le code de la
// résolution : `voice_key_missing` avec `source`, `voice_setting_missing`,
// `voice_setting_unreadable`…, #976), `transcription_failed` 502 (avec
// `detail`, les mots du fournisseur, masqués). Chaque refus est écrit au
// journal du runner avec son code. Rien n'est rangé. Sinon la
// réponse est `text/event-stream`, et ses événements sont, dans cet ordre :
//
//   event: nothing_heard  data: { durationMs, model }  SEUL événement du flux : aucun mot
//                                                      entendu, rien n'est rangé
//   event: transcript     data: { transcript, durationMs }   le message de la personne,
//                                                      dès qu'il existe (rangé comme dit)
//   event: delta          data: { text }               un fragment de la réponse, comme
//                                                      `/api/chat/stream`
//   event: audio          data: { seq, sentence, mimeType, sampleRate?, base64 }
//                                                      la voix, en morceaux NUMÉROTÉS
//                                                      depuis 0, sans trou, à jouer
//                                                      bout à bout dans l'ordre de `seq`.
//                                                      `audio/pcm` : 16 bits signés
//                                                      little-endian, mono, à `sampleRate` ;
//                                                      les autres types (`audio/wav`, `audio/mpeg`…)
//                                                      ne se décodent que par phrase entière
//   event: audio_end      data: { sentence, complete } la phrase `sentence` (son rang,
//                                                      depuis 0) est finie : UNE fois pour
//                                                      chaque phrase dont un `audio` est
//                                                      sorti, toujours avant `done`.
//                                                      `complete` faux : elle s'est arrêtée
//                                                      en route (échec de la voix, phrase
//                                                      abandonnée, Stop). Un type compressé
//                                                      se joue à ce signal s'il est complet,
//                                                      et se jette sinon ; un PCM déjà joué
//                                                      s'arrête là où la voix s'est arrêtée
//   event: done           data: { reply, spawnedJobId, streamed, stopped, cutReason,
//                                 speechError }      le DERNIER événement, après tout l'audio
//   event: error          data: { error, detail? }     le tour a échoué après la
//                                                      transcription (les codes du chat)
//
// `delta` et `audio` se mêlent : la voix d'une phrase part dès qu'elle est
// écrite, pendant que la suivante s'écrit. `done.reply` est la réponse ENTIÈRE
// et fait foi, comme pour `/api/chat/stream` ; `streamed` dit si les `delta`
// la disaient. `speechError` { code, detail? } : la voix a échoué, le texte
// reste. `stopped` : la personne a dit Stop (`/api/chat/stop`, le même Stop que
// le chat écrit) ; plus aucun audio ne suit. Les secrets que la réponse
// citerait sont masqués dans `delta`, dans `done.reply` ET dans ce qui est
// dit (chat/run-voice-turn.ts) ; la ligne rangée en base reste intacte.
//
// Un client de vingt lignes :
//
//   const { turnId } = await post('/api/voice/turns', { entityId, conversationId,
//                                  format: 'audio/pcm', sampleRate: 16000 });
//   let seq = 0;
//   for await (const pcm of microphone()) await postBytes(`/api/voice/turns/${turnId}/chunks/${seq++}`, pcm);
//   for await (const ev of sse(await post(`/api/voice/turns/${turnId}/end`))) {
//     if (ev.event === 'audio') speaker.play(ev.data);   // dans l'ordre de seq
//     if (ev.event === 'done' || ev.event === 'nothing_heard' || ev.event === 'error') break;
//   }
//
// Chaque tour écrit une ligne `[voice-turn] timing {…}` : la voix et le modèle
// qui a transcrit (#976), puis les millisecondes
// depuis la requête de fin jusqu'à la transcription, au premier fragment, à la
// première phrase complète, au premier octet que le fournisseur de voix rend
// pour elle et à la fin de sa réponse (proches : il rend un fichier ; écartés :
// il diffuse), au premier octet de voix envoyé et à `done`. Des nombres
// seulement, jamais les mots de la personne.
//
// L'ORIGINE EST UNE DONNÉE (règle du #948) : le tour appartient à la
// conversation qu'il nomme, et l'agent est celui de cette conversation. Aucune
// branche « est-ce le tableau de bord » ; le tableau de bord passera par son
// proxy (#942) comme n'importe quel client.
//
// AUTORISATION : la garde du runner, la même que `/api/chat*` (server.ts). La
// route ne lit que ce que la garde pose sur le contexte (`callerTrusted`,
// `callerEntityId`) : quand #946 ajoutera le jeton d'un module, il posera les
// mêmes faits, et cette route n'aura pas à changer. Rien ici ne demande une
// session du tableau de bord.

import type { Context } from 'hono';
import { z } from 'zod';
import { and, conversations, eq } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';
import { resolveEar } from '../job/resolve-voice.ts';
import { readBoundedBody } from '../lib/read-bounded-body.ts';
import { createVoiceTiming, hearVoiceTurn, speakVoiceTurn } from '../chat/run-voice-turn.ts';
import { sseEvent, SSE_HEADERS } from './sse.ts';
import {
  VOICE_FORMATS,
  VOICE_LIMITS,
  appendChunk,
  cancelUtterance,
  openUtterance,
  peekUtterance,
  takeUtterance,
  type VoiceUtterance,
} from '../chat/voice-utterances.ts';

const StartSchema = z
  .object({
    entityId: z.string().guid(),
    conversationId: z.string().guid(),
    format: z.enum(VOICE_FORMATS),
    // Le PCM brut ne dit pas sa fréquence : elle est annoncée. Un WAV la porte
    // dans son en-tête : l'annoncer aussi donnerait deux sources qui peuvent
    // se contredire, et l'une des deux serait crue en silence.
    sampleRate: z.number().int().min(8_000).max(192_000).optional(),
  })
  .refine((b) => (b.format === 'audio/pcm') === (b.sampleRate !== undefined), {
    message: 'sampleRate is required for audio/pcm and refused for audio/wav',
    path: ['sampleRate'],
  });

/**
 * Le tour `turnId` s'il appartient à l'appelant. Un appelant de confiance (le
 * web avec WORKER_SECRET, local-trust) a déjà résolu son entité ; un porteur
 * de session n'atteint que les tours de SON entité. Un tour d'une autre
 * entité répond comme un tour inexistant : son existence ne se devine pas.
 */
function ownTurn(c: Context, turnId: string): VoiceUtterance | undefined {
  const u = peekUtterance(turnId);
  if (!u) return undefined;
  if (!c.get('callerTrusted') && u.entityId !== c.get('callerEntityId')) return undefined;
  return u;
}

export async function voiceTurnStartRoute(c: Context, deps: RunnerDeps): Promise<Response> {
  const parsed = StartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId, conversationId, format, sampleRate } = parsed.data;
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const [conv] = await deps.db
    .select({ agentId: conversations.agentId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
    .limit(1);
  if (!conv?.agentId) return c.json({ error: 'conversation_not_found' }, 404);

  // Dit AVANT que la personne parle : sans oreille (pas de clé OpenRouter, un
  // réglage de voix illisible), rien de ce qu'elle dirait ne serait entendu.
  // Le code est celui de la résolution (#976), le même qu'à la fin du tour.
  const ear = await resolveEar(deps.db, entityId);
  if (!ear.ok) {
    return c.json({ error: ear.code, ...(ear.source ? { source: ear.source } : {}) }, 409);
  }

  const opened = openUtterance({
    entityId,
    conversationId,
    agentId: conv.agentId,
    format:
      format === 'audio/pcm' && sampleRate !== undefined
        ? { kind: 'audio/pcm', sampleRate }
        : { kind: 'audio/wav' },
  });
  if (!opened.ok) return c.json({ error: opened.error }, 429);
  return c.json({ turnId: opened.id }, 201);
}

export async function voiceTurnChunkRoute(c: Context): Promise<Response> {
  const turnId = c.req.param('turnId') ?? '';
  const seq = Number(c.req.param('seq'));
  if (!Number.isInteger(seq) || seq < 0) return c.json({ error: 'invalid_request' }, 400);
  const u = ownTurn(c, turnId);
  if (!u) return c.json({ error: 'turn_not_found' }, 404);

  // La LECTURE elle-même est bornée à ce que le tour peut encore recevoir
  // (revue de #958, passe 1) : un corps en `Transfer-Encoding: chunked` n'a
  // pas de Content-Length, et `arrayBuffer()` l'aurait alloué en entier avant
  // tout refus. Le tour entier part, comme dans `appendChunk`.
  const read = await readBoundedBody(c.req.raw, VOICE_LIMITS.maxBytes - u.bytes);
  if (!read.ok) {
    cancelUtterance(turnId);
    return c.json({ error: 'audio_too_long' }, 413);
  }
  const appended = appendChunk(turnId, seq, read.bytes);
  if (!appended.ok) {
    const status =
      appended.error === 'turn_not_found' ? 404 : appended.error === 'audio_too_long' ? 413 : 409;
    return c.json(
      { error: appended.error, ...(status === 409 ? { expected: u.nextSeq } : {}) },
      status,
    );
  }
  return c.json({ received: appended.received });
}

export async function voiceTurnEndRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  const startedAt = Date.now();
  const turnId = c.req.param('turnId') ?? '';
  if (!ownTurn(c, turnId)) return c.json({ error: 'turn_not_found' }, 404);
  const u = takeUtterance(turnId);
  if (!u) return c.json({ error: 'turn_not_found' }, 404);

  const heard = await hearVoiceTurn(deps, u);
  if (heard.outcome === 'failed') {
    return c.json(
      { error: heard.error, ...(heard.detail ? { detail: heard.detail } : {}) },
      heard.status,
    );
  }

  const timing = createVoiceTiming(startedAt);
  timing.ear(heard.model);
  const readerGone = new AbortController();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          // Le lecteur est parti : la voix se tait, le tour écrit sa ligne.
          closed = true;
          readerGone.abort();
        }
      };

      void (async () => {
        try {
          if (heard.outcome === 'nothing_heard') {
            // Le modèle qui n'a rien écrit (#976), pour que l'écran le nomme ;
            // `null` : aucun échantillon, rien n'est parti au fournisseur.
            send('nothing_heard', { durationMs: heard.durationMs, model: heard.model });
            return;
          }
          await speakVoiceTurn(deps, runnerEnv, u, heard, send, {
            timing,
            readerGone: readerGone.signal,
          });
        } catch (err) {
          console.error('[voiceTurnRoute] turn failed:', err);
          send('error', { error: 'chat_failed' });
        } finally {
          timing.mark('done');
          // `warn` : le canal des lignes de journal du runner (comme
          // `llm_call_progress`), pas une alerte.
          console.warn(timing.line());
          closed = true;
          try {
            controller.close();
          } catch {
            // Déjà fermé par le lecteur.
          }
        }
      })();
    },
    cancel() {
      readerGone.abort();
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}

export function voiceTurnCancelRoute(c: Context): Response {
  const turnId = c.req.param('turnId') ?? '';
  if (!ownTurn(c, turnId)) return c.json({ error: 'turn_not_found' }, 404);
  return c.json({ cancelled: cancelUtterance(turnId) });
}
