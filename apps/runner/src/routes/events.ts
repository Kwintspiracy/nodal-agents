// routes/events.ts — GET /api/events — le flux poussé des événements de job (#944).
//
// Un client écoute UN espace, éventuellement restreint à UNE conversation, et
// reçoit ce qui s'y passe au moment où la base le dit : un job fini (avec sa
// réponse), un job en échec, une question posée, une approbation demandée,
// une demande tranchée. Le bus, ce qu'il garde et pourquoi : `events/job-events.ts`.
//
// UNE route pour tous les clients (règle de #948) : le tableau de bord la lit
// par son proxy (`apps/web/src/app/api/events/route.ts`), un module externe la
// lit directement, avec le même protocole et la même garde. Rien ici ne sait
// qui écoute.
//
// Requête :
//   GET /api/events?entityId=<uuid>[&conversationId=<uuid>]
//   Last-Event-ID: <id>     (ou `?lastEventId=<id>` pour un client qui ne pose
//                            pas d'en-tête à sa première connexion)
//
// Réponses :
//   400  requête illisible            403  l'espace n'est pas celui de l'appelant
//   404  conversation hors de l'espace
//   200  text/event-stream, chaque événement avec son `id:` :
//        event: ready     data: {}                       en direct (après ce qui a été rejoué)
//        event: resync    data: { "reason": "<code>" }   relire la base : ce qui a été
//                                                        manqué n'est plus en mémoire
//        event: job.finished | job.failed | question.asked | approval.requested |
//               approval.resolved                        data: voir `JobEventPayload`
//        event: reply.audio   data: { jobId, conversationId, audioId }   juste après
//                             le `job.finished` d'un job lancé par la voix : sa
//                             réponse est dite, sur `GET /api/voice/replies/:audioId`
//                             (#967, le protocole est dans routes/voice-reply.ts)
//   Un commentaire `: ping` toutes les 25 s tient la connexion ouverte à
//   travers les proxys.
//
// Ce qu'un client qui revient reçoit (invariant #4) : ce qu'il a manqué, dans
// l'ordre, ou un `resync`. Jamais rien en silence. `ready` et `resync` portent
// un `id:` : le client a un point de reprise avant même le premier événement.
//
// La garde : `requireRunnerAuth` (server.ts), comme `/api/chat*`. Un appelant
// de confiance (local-trust, WORKER_SECRET) a résolu l'espace lui-même ; un
// porteur de session ne lit que le SIEN. Le jeton d'appareil de #946 entrera
// par cette même garde, en posant `callerEntityId` : la route n'a rien à
// apprendre de plus.

import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, conversations } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import { jobEvents, type JobEventBus, type StoredJobEvent } from '../events/job-events.ts';
import { sseEvent, SSE_HEADERS } from './sse.ts';

const EventsQuerySchema = z.object({
  entityId: z.string().guid(),
  conversationId: z.string().guid().optional(),
  lastEventId: z.string().min(1).max(200).optional(),
});

/** Le battement qui tient la connexion ouverte à travers les proxys. */
export const EVENTS_PING_MS = 25_000;

/** Un événement SSE avec son identifiant de reprise. */
function sseWithId(id: string, event: string, data: unknown): string {
  return `id: ${id}\n${sseEvent(event, data)}`;
}

export async function eventsRoute(
  c: Context,
  deps: RunnerDeps,
  bus: JobEventBus = jobEvents,
): Promise<Response> {
  const parsed = EventsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { entityId } = parsed.data;
  const conversationId = parsed.data.conversationId ?? null;
  const lastEventId = c.req.header('last-event-id') ?? parsed.data.lastEventId ?? null;

  // L'espace de l'appelant, et lui seul.
  if (!c.get('callerTrusted') && entityId !== c.get('callerEntityId')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (conversationId !== null) {
    const [conv] = await deps.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.entityId, entityId)))
      .limit(1);
    if (!conv) return c.json({ error: 'conversation_not_found' }, 404);
  }

  const encoder = new TextEncoder();
  let stop: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Le battement est armé AVANT tout envoi : un lecteur parti dès la reprise
      // l'arrête par `stop`, au lieu de le laisser battre pour personne.
      const ping = setInterval(() => write(': ping\n\n'), EVENTS_PING_MS);
      // Un battement ne garde pas le processus en vie à lui seul.
      ping.unref?.();
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Le lecteur est parti : on se désinscrit.
          stop();
        }
      };
      const send = (e: StoredJobEvent): void => write(sseWithId(e.id, e.payload.type, e.payload));

      // L'ouverture et l'inscription sont atomiques (`bus.open`) : rien ne
      // tombe entre ce qui est rejoué et le direct.
      const sub = bus.open(entityId, conversationId, lastEventId, send);
      stop = () => {
        if (closed) return;
        closed = true;
        sub.close();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // Déjà fermé par le lecteur.
        }
      };

      // Ce qui a été manqué d'abord, puis `ready` : le client est en direct, et
      // son point de reprise est le dernier événement de l'espace. Ou bien un
      // `resync` à la place des deux.
      const { opening } = sub;
      if (opening.kind === 'resync') {
        write(sseWithId(opening.headId, 'resync', { type: 'resync', reason: opening.reason }));
      } else {
        if (opening.kind === 'replay') for (const e of opening.events) send(e);
        write(sseWithId(opening.headId, 'ready', {}));
      }
    },
    cancel() {
      stop();
    },
  });
  // La requête abandonnée (onglet fermé, client coupé) libère son abonnement.
  c.req.raw.signal.addEventListener('abort', () => stop(), { once: true });

  return new Response(stream, { headers: { ...SSE_HEADERS } });
}
